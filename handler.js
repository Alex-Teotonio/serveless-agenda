//handler.js
const AWS = require("aws-sdk");
const { google } = require("googleapis");
const { authorize } = require("./src/middleware/authorize");
const jwt = require('jsonwebtoken');
const { JWT_SECRET } = process.env;



const dynamo = new AWS.DynamoDB.DocumentClient();

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  "https://vprikxgmlf.execute-api.us-east-1.amazonaws.com/oauth2callback"
);

const twilio = require("twilio");
const accountSid = process.env.ACCOUNT_SID_TWILIO;
const authToken = process.env.AUTH_TOKEN_TWILIO;

const client = new twilio(accountSid, authToken);

async function ensureValidToken(userId) {
  // Busca os tokens armazenados para o usuário
  const params = {
    TableName: process.env.USERS_TABLE,
    Key: { userId },
  };
  const result = await dynamo.get(params).promise();
  if (!result.Item || !result.Item.googleTokens) {
    throw new Error("Usuário não autenticado no Google.");
  }
  const tokens = result.Item.googleTokens;
  oauth2Client.setCredentials(tokens);

  try {
    // getAccessToken() irá renovar o token se estiver expirado.
    const tokenResponse = await oauth2Client.getAccessToken();
    // Se houver um novo token (a propriedade expiry_date pode ter sido atualizada), atualize o registro.
    const newTokens = oauth2Client.credentials;
    if (
      newTokens.access_token &&
      newTokens.expiry_date !== tokens.expiry_date
    ) {
      await dynamo
        .update({
          TableName: process.env.USERS_TABLE,
          Key: { userId },
          UpdateExpression: "SET googleTokens = :tokens",
          ExpressionAttributeValues: {
            ":tokens": newTokens,
          },
        })
        .promise();
      console.log("Token atualizado para o userId:", userId);
    }
  } catch (error) {
    console.error("Erro ao atualizar token:", error);
    throw error;
  }
}

async function getFromNumberByUserId(userId) {
  const res = await dynamo
    .get({
      TableName: process.env.USERS_TABLE,
      Key: { userId },
    })
    .promise();

  if (!res.Item || !res.Item.telefone_whatsapp) {
    throw new Error("Número de WhatsApp do nutricionista não encontrado");
  }

  return res.Item.telefone_whatsapp;
}


async function sendTemplateMessage(to, variables, templateId, userId) {
  try {
    const fromNumber = await getFromNumberByUserId(userId);
    const message = await client.messages.create({
      from: `whatsapp:${fromNumber}`,
      contentSid: templateId,
      contentVariables: JSON.stringify(variables),
      to: `whatsapp:${to}`,
    });
    console.log(`? Mensagem enviada de ${fromNumber}: ${message.sid}`);
  } catch (error) {
    console.error(`? Erro ao enviar mensagem de ${fromNumber}:`, error);
  }
}

async function sendTemplateMessageToNutritionist(numberNutritionist, variables, templateId,numberPatient) {
  try {
    const message = await client.messages.create({
      from: `whatsapp:+${numberPatient}`,
      contentSid: templateId,
      contentVariables: JSON.stringify(variables),
      to: `whatsapp:${numberNutritionist}`,
    });
    console.log(`? Mensagem enviada de +553195316802: ${message.sid}`);
  } catch (error) {
    console.error(`? Erro ao enviar mensagem de +553195316802:`, error);
  }
} 

async function sendWhatsAppTextMessage(to, message, userId) {
  try {
    const fromNumber = await getFromNumberByUserId(userId);

    if (!to.startsWith("whatsapp:")) {
      to = `whatsapp:${to}`;
    }

    const msg = await client.messages.create({
      from: `whatsapp:${fromNumber}`,
      body: message,
      to: to,
    });

    console.log(`Mensagem simples enviada de ${fromNumber}: ${msg.sid}`);
  } catch (error) {
    console.error("Erro ao enviar mensagem simples:", error);
  }
}


module.exports.googleCalendarAuth = authorize(async (event) => {
  const nutriId = event.requestContext.authorizer.nutriId;

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt:       'consent',
    scope: ["https://www.googleapis.com/auth/calendar"],
    state: nutriId,
  });

  return {
    statusCode: 302,
    headers: {
      Location: authUrl,
    },
  };
});


module.exports.createEvent = async (event, context) => {
  const { patientPK, patientSK, summary, location, start, end } = JSON.parse(event.body);
  const nutriId = event.requestContext.authorizer.nutriId; // ou req.nutriId, dependendo de como o serverless-http passa

  // 1) Busca dados do paciente
  const patParams = {
    TableName: process.env.PATIENTS_TABLE,
    Key: {
      PK: `NUTRICIONISTA#${nutriId}`,
      SK: patientSK
    },
  };
  const { Item: paciente } = await dynamo.get(patParams).promise();
  if (!paciente) {
    return { statusCode: 404, body: JSON.stringify({ error: "Paciente n�o encontrado" }) };
  }

  // 2) Garante token Google
  await ensureValidToken(nutriId);
  const userParams = { TableName: process.env.USERS_TABLE, Key: { userId: nutriId } };
  const userResult = await dynamo.get(userParams).promise();
  oauth2Client.setCredentials(userResult.Item.googleTokens);

  // 3) Insere no Google Calendar
  const calendar = google.calendar({ version: "v3", auth: oauth2Client });
  const response = await calendar.events.insert({
    calendarId: "primary",
    resource: {
      summary,
      location,
      description: `Contato: ${paciente.telefone_whatsapp} Paciente: ${paciente.nome}`,
      start: { dateTime: start },
      end: { dateTime: end },
      extendedProperties: {
        private: {
          pacientePK: paciente.PK,
          pacienteSK: paciente.SK,
        },
      },
    },
  });

  return { statusCode: 200, body: JSON.stringify(response.data) };
};
module.exports.oauth2callback = async (event) => {
  const { code, state: userId } = event.queryStringParameters;
  const { tokens } = await oauth2Client.getToken(code);

  // Carrega tokens antigos
  const { Item } = await dynamo.get({
    TableName: process.env.USERS_TABLE,
    Key: { userId }
  }).promise();
  const oldTokens = Item?.googleTokens || {};

  // Faz merge: usa o novo refresh_token se veio, senão mantém o antigo
  const merged = {
    ...oldTokens,
    ...tokens,
    refresh_token: tokens.refresh_token || oldTokens.refresh_token,
  };

  // Salva de volta
  await dynamo.update({
    TableName: process.env.USERS_TABLE,
    Key: { userId },
    UpdateExpression: 'SET googleTokens = :t',
    ExpressionAttributeValues: { ':t': merged }
  }).promise();

  return {
    statusCode: 200,
    body: JSON.stringify({ message: 'Autenticação com sucesso!' })
  };
};


async function getPatientNameByPhone(phone) {
  const params = {
    TableName: process.env.PATIENTS_TABLE,
    IndexName: 'ByTelefone',
    KeyConditionExpression: 'telefone_whatsapp = :tel',
    ExpressionAttributeValues: {
      ':tel': phone,
    },
    Limit: 1,
  };

  try {
    const result = await dynamo.query(params).promise();
    return result.Items?.[0]?.nome || null;
  } catch (err) {
    console.error("Erro ao buscar paciente por telefone:", err);
    return null;
  }
}

async function findUserIdByFromNumber(from) {
  console.log("📨 Número recebido (from):", from);

  const cleanFrom = from.replace("whatsapp:", "");
  console.log("🔍 Número sem prefixo (cleanFrom):", cleanFrom);

  const params = {
    TableName: process.env.USERS_TABLE,
    IndexName: "ByTelefoneNutri",
    KeyConditionExpression: "telefone_whatsapp = :telefone",
    ExpressionAttributeValues: {
      ":telefone": cleanFrom,
    },
  };

  console.log("📤 Parâmetros da query:", JSON.stringify(params, null, 2));

  try {
    const result = await dynamo.query(params).promise();

    console.log("📥 Resultado da query:", JSON.stringify(result, null, 2));

    if (result.Items.length > 0) {
      console.log("✅ userId encontrado:", result.Items[0].userId);
      return result.Items[0].userId;
    } else {
      console.warn("⚠️ Nenhum item encontrado para telefone:", cleanFrom);
      return null;
    }
  } catch (error) {
    console.error("❌ Erro ao buscar userId por telefone:", error);
    throw error;
  }
}

module.exports.demoReply = async (event) => {
  console.log("Evento recebido:", event);
  const querystring = require("querystring");
  let bodyRaw = event.body;
if (event.isBase64Encoded) {
  const buff = Buffer.from(event.body, "base64");
  bodyRaw = buff.toString("utf-8");
}

const bodyParams = querystring.parse(bodyRaw);
  const from = bodyParams.From; // Número do paciente (ex: whatsapp:+55...)
  console.log("Parâmetros do body:", bodyParams);
  const to = bodyParams.To;     // Número da nutricionista (ex: whatsapp:+55...)

  try {
    // Busca o userId baseado no número que enviou a mensagem Segue resultado d(nutricionista)
    console.log("Número da nutricionista (to):", to);

    const userId = await findUserIdByFromNumber(to);
    console.log("Buscando fromNumber com userId:", userId);
    const fromNumber = to.replace("whatsapp:", ""); // Ex: +553193630577

    const nome = await getPatientNameByPhone(from) || from;

    // Extrai o ButtonPayload se existir, senão utiliza o Body
    const responseId = (bodyParams.ButtonPayload || bodyParams.Body || "")
      .toLowerCase()
      .trim();

    console.log(`Resposta recebida do paciente ${nome} (${from}):`, responseId);

    if (
      responseId === "confirm" ||
      responseId === "cancel" ||
      responseId === "confirm_seven" ||
      responseId === "cancel_seven"
    ) {
      if (responseId === "confirm") {
        console.log(`Paciente ${nome} confirmou a consulta: ${from}`);
        await sendWhatsAppTextMessage(from, "Sua consulta foi confirmada! ✅",userId);
        await sendTemplateMessageToNutritionist(
          fromNumber,
          { 1: nome, 2: "confirmou" },
          "HX63a1d3ac2863fb13dd811dee40ced592",
          from
        );
      } else if (responseId === "cancel") {
        await sendWhatsAppTextMessage(
          from,
          "Sua consulta foi cancelada. Em breve entraremos em contato com as opções de reagendamento.",
          userId
        );
        await sendTemplateMessageToNutritionist(
          fromNumber,
          { 1: nome, 2: "cancelou" },
          "HX63a1d3ac2863fb13dd811dee40ced592",
          from
        );
      } else if (responseId === "confirm_seven") {
        await sendWhatsAppTextMessage(
          from,
          "Você confirmou seu pré-agendamento. Aguarde nossa confirmação!",
          userId
        );
        await sendTemplateMessageToNutritionist(
          fromNumber,
          { 1: nome, 2: "confirmou" },
          "HX395c25bc3600cc005e8f8b80f142da06",
          from
        );
      } else if (responseId === "cancel_seven") {
        await sendWhatsAppTextMessage(
          from,
          "Você cancelou seu pré-agendamento. Em breve, entraremos em contato para reagendamento.",
          userId
        );
        await sendTemplateMessageToNutritionist(
          fromNumber,
          { 1: nome, 2: "cancelou" },
          "HX395c25bc3600cc005e8f8b80f142da06",
          from
        );
      }
    } else {
      await sendWhatsAppTextMessage(
        from,
        "Este número é exclusivo para notificações de consultas. " +
          "Por favor, utilize apenas as opções disponíveis (Confirmar ou Cancelar). " +
          "Qualquer outra solicitação não será reconhecida. Para assuntos diferentes ou reagendamento entre em contato: (31) 99531-6802.",
          userId
      );
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'text/xml' },
      body: '<Response></Response>',
    };
    
    
  } catch (error) {
    console.error("Erro na demoReply:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Erro ao processar mensagem recebida." }),
    };
  }
};


function extractClientInfo(description) {
  // Expressão para extrair o telefone após "Contato:"
  const phoneRegex = /Contato:\s*(\+?\d+)/i;
  // Expressão para extrair o nome após "Paciente:"
  const nameRegex = /Paciente:\s*([^\r\n]+)/i;

  const phoneMatch = description && description.match(phoneRegex);
  const nameMatch = description && description.match(nameRegex);

  let phone = null;
  let name = null;

  if (phoneMatch && phoneMatch[1]) {
    // Remove o sinal de '+' e adiciona o prefixo "55" se não estiver presente
    phone = phoneMatch[1].replace("+", "");
    if (!phone.startsWith("55")) {
      phone = "+55" + phone;
    } else {
      phone = "+" + phone;
    }
  }

  if (nameMatch && nameMatch[1]) {
    name = nameMatch[1].trim();
  }

  return { phone, name };
}

// Funções auxiliares para gerenciar o estado do questionário no DynamoDB
async function getSurveyState(from) {
  const params = {
    TableName: "surveyStates", // certifique-se de que essa tabela exista no DynamoDB
    Key: { phone: from },
  };
  const result = await dynamo.get(params).promise();
  return result.Item || { currentQuestion: 0, responses: {} };
}
// Função para listar eventos que ainda não receberam uma notificação
// targetOffsetDays: número de dias a partir de hoje.
// Por exemplo, 2 para confirmação 2 dias antes, 7 para 7 dias antes.
// Para suporte (após o evento), use um valor negativo, por exemplo, -15.
async function listEventsForNotification(notificationType, targetOffsetDays) {
  const now = new Date();

  // por algo assim:
  const nowSp = new Date(
    new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo" })
  );
  // agora worka no fuso do usuário
  const targetDate = new Date(nowSp);
  targetDate.setDate(nowSp.getDate() + targetOffsetDays);

  const startOfDay = new Date(targetDate);
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(targetDate);
  endOfDay.setHours(23, 59, 59, 999);

  const calendar = google.calendar({ version: "v3", auth: oauth2Client });
  const response = await calendar.events.list({
    calendarId: "primary",
    timeMin: startOfDay.toISOString(),
    timeMax: endOfDay.toISOString(),
    timeZone: "America/Sao_Paulo",
    singleEvents: true,
    orderBy: "startTime",
  });
  console.log("Eventos retornados:", response.data.items);

  // Filtra os eventos que ainda não foram notificados para esse tipo
  return response.data.items.filter((event) => {
    const props =
      event.extendedProperties && event.extendedProperties.private
        ? event.extendedProperties.private
        : {};
    return !props[notificationType];
  });
}

// Função para marcar um evento como notificado para um tipo específico
async function markEventAsNotified(eventId, notificationType) {
  const calendar = google.calendar({ version: "v3", auth: oauth2Client });
  // Recupera o evento atual
  const eventResponse = await calendar.events.get({
    calendarId: "primary",
    eventId,
  });
  const event = eventResponse.data;
  const currentProps =
    (event.extendedProperties && event.extendedProperties.private) || {};
  currentProps[notificationType] = "true";

  // Usa patch para atualizar somente as extendedProperties sem precisar enviar start/end
  await calendar.events.patch({
    calendarId: "primary",
    eventId,
    resource: {
      extendedProperties: {
        private: currentProps,
      },
    },
  });
}

// Função para enviar notificações para uma lista de eventos
// getMessageVariables: callback para extrair as variáveis necessárias do evento
async function sendNotificationsForEvents(
  events,
  notificationType,
  templateId,
  getMessageVariables,
  userId
) {
  let messagesSent = 0;
  for (const event of events) {
    const clientInfo = extractClientInfo(event.description);
    if (!clientInfo.phone) {
      console.error("Telefone não encontrado para o evento:", event.id);
      continue;
    }
    const variables = getMessageVariables(event);
    await sendTemplateMessage(clientInfo.phone, variables, templateId,userId);
    await markEventAsNotified(event.id, notificationType);
    messagesSent++;
  }
  return messagesSent;
}

function getNutriIdFromEvent(event) {
  const auth = event.headers.Authorization || event.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    throw new Error('Não autenticado: faltando token');
  }
  const token = auth.slice(7); // remove 'Bearer '
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    return payload.nutriId;
  } catch (err) {
    console.error('Token inválido:', err);
    throw new Error('Não autenticado: token inválido');
  }
}

// Envia as mensagens de confirmação para os eventos listados
module.exports.sendConfirmation2Days = async (event) => {
  try {
    const userId = getNutriIdFromEvent(event);
    await ensureValidToken(userId);
    const events = await listEventsForNotification("notified_2days", 2);

    const messagesSent = await sendNotificationsForEvents(
      events,
      "notified_2days",
      "HX8ed3f6db3846d650fa7e1e09ca24cc48", // ID do template para confirmação 2 dias
      (event) => {
        const eventDate = new Date(event.start.dateTime || event.start.date);
        return {
          1: extractClientInfo(event.description).name || "Cliente",
          2: eventDate.toLocaleDateString("pt-BR"),
          3: eventDate.toLocaleTimeString("pt-BR", {
            hour: "2-digit",
            minute: "2-digit",
            timeZone: event.start.timeZone,
          }),
        };
      },
      userId
    );
    return {
      statusCode: 200,
      body: JSON.stringify({
        message: `Processadas ${messagesSent} mensagens de confirmação (2 dias).`,
      }),
    };
  } catch (error) {
    console.error("Erro ao enviar confirma��o 2 dias:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Erro ao enviar confirma��o 2 dias." }),
    };
  }
};
// Envia as mensagens de confirmação para os eventos listados
module.exports.sendConfirmation7Days = async (event) => {
  try {
    const userId = getNutriIdFromEvent(event);
    await ensureValidToken(userId);
    const events = await listEventsForNotification("notified_7days", 7);
    const messagesSent = await sendNotificationsForEvents(
      events,
      "notified_7days",
      "HXc0b6a01cb6c702c1ce00a9f241f692d4", // ID do template para confirmação 7 dias
      (event) => {
        const eventDate = new Date(event.start.dateTime || event.start.date);
        return {
          1: extractClientInfo(event.description).name || "Cliente",
          2: eventDate.toLocaleDateString("pt-BR"),
          3: eventDate.toLocaleTimeString("pt-BR", {
            hour: "2-digit",
            minute: "2-digit",
            timeZone: event.start.timeZone,
          }),
        };
      },
      userId
    );
    return {
      statusCode: 200,
      body: JSON.stringify({
        message: `Processadas ${messagesSent} mensagens de confirmação (7 dias).`,
      }),
    };
  } catch (error) {
    console.error("Erro ao enviar confirma��o 7 dias:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Erro ao enviar confirma��o 7 dias." }),
    };
  }
};

// Lista os eventos para suporte (exemplo: 15 dias após o evento, targetOffsetDays negativo: -15)
module.exports.listSupportEvents = async () => {
  try {
    const events = await listEventsForNotification("notified_support", -15);
    return {
      statusCode: 200,
      body: JSON.stringify({ events }),
    };
  } catch (error) {
    console.error("Erro ao listar eventos de suporte:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Erro ao listar eventos de suporte." }),
    };
  }
};

async function getSentMessagesToday() {
  const now = new Date();
  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);

  const messages = await client.messages.list({
    dateSentAfter: startOfDay.toISOString(), // Envia no formato ISO
    limit: 50 // você pode ajustar conforme sua necessidade
  });

  // Filtra apenas WhatsApp se quiser
  const whatsappMessages = messages.filter(msg => msg.from.startsWith('whatsapp:'));

  return whatsappMessages;
}


module.exports.listSentMessagesToday = async () => {
  try {
    const messages = await getSentMessagesToday();

    const detailedMessages = messages.map(msg => ({
      sid: msg.sid,
      to: msg.to,
      from: msg.from,
      body: msg.body,
      status: msg.status,
      dateSent: msg.dateSent,
      dateCreated: msg.dateCreated,
      errorCode: msg.errorCode,
      errorMessage: msg.errorMessage
    }));

    const summary = {
      total: messages.length,
      byStatus: {},
      details: detailedMessages
    };

    messages.forEach(msg => {
      summary.byStatus[msg.status] = (summary.byStatus[msg.status] || 0) + 1;
    });

    return {
      statusCode: 200,
      body: JSON.stringify(summary),
    };
  } catch (err) {
    console.error("Erro ao buscar mensagens:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Erro ao buscar mensagens." }),
    };
  }
};



