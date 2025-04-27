const serverless = require("serverless-http");
const express = require("express");
const AWS = require("aws-sdk");
const { v4: uuidv4 } = require("uuid");
const bcrypt = require("bcrypt");
const { body, validationResult } = require("express-validator");
const jwt = require("jsonwebtoken");
const { google } = require("googleapis");

const app = express();
app.use(express.json());

const dynamo = new AWS.DynamoDB.DocumentClient();

const usersTable = process.env.USERS_TABLE;
const agendazapTable = process.env.AGENDAZAP_TABLE;

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  "https://y5ghcb4jv8.execute-api.us-east-1.amazonaws.com/dev/oauth2callback"
);

const twilio = require("twilio");
const accountSid = process.env.ACCOUNT_SID_TWILIO;
const authToken = process.env.AUTH_TOKEN_TWILIO;

const client = new twilio(accountSid, authToken);

async function ensureValidToken(userId) {
  console.log("Verificando token para userId:", userId);
  console.log("USERS_TABLE:", process.env.USERS_TABLE);
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

async function sendTemplateMessage(to, variables, templateId) {
  try {
    const message = await client.messages.create({
      from: "whatsapp:+553193630577",
      contentSid: templateId,
      contentVariables: JSON.stringify(variables),
      to: `whatsapp:${to}`,
    });
    console.log("Template Message sent:", message.sid);
  } catch (error) {
    console.error("Erro ao enviar template message:", error);
  }
}

async function sendWhatsAppMessage(to, variables) {
  try {
    const message = await client.messages.create({
      from: "whatsapp:+553193630577",
      contentSid: "HX8ed3f6db3846d650fa7e1e09ca24cc48",
      contentVariables: JSON.stringify(variables),
      to: `whatsapp:${to}`,
    });

    console.log("Message sent:", message.sid);
  } catch (error) {
    console.error("Erro ao enviar mensagem:", error);
  }
}

async function sendWhatsAppTextMessage(to, message) {
  console.log("Enviando mensagem simples para:", to);
  if (!to.startsWith("whatsapp:")) {
    to = `whatsapp:${to}`;
  }
  console.log(to);
  try {
    const msg = await client.messages.create({
      from: "whatsapp:+553193630577",
      body: message,
      to: to,
    });

    console.log("Mensagem simples enviada:", msg.sid);
  } catch (error) {
    console.error("Erro ao enviar mensagem simples:", error);
  }
}

// Rota para registrar usuário
app.post(
  "/register",
  [
    body("nome").notEmpty().withMessage("Nome é obrigatório."),
    body("email").isEmail().withMessage("Email inválido."),
    body("senha")
      .isLength({ min: 6 })
      .withMessage("Senha deve ter pelo menos 6 caracteres."),
    body("telefone_whatsapp")
      .notEmpty()
      .withMessage("Telefone WhatsApp é obrigatório."),
  ],
  async (req, res) => {
    // Validação dos dados
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { nome, email, senha, telefone_whatsapp } = req.body;

    const userId = uuidv4();
    const timestamp = new Date().toISOString();

    // Hash da senha para segurança
    const hashedSenha = await bcrypt.hash(senha, 10);

    const emailParams = {
      TableName: usersTable,
      IndexName: "EmailIndex",
      KeyConditionExpression: "email = :email",
      ExpressionAttributeValues: {
        ":email": email,
      },
    };

    try {
      const emailResult = await dynamo.query(emailParams).promise();
      if (emailResult.Items.length > 0) {
        return res.status(409).json({ message: "Email já está em uso." });
      }

      const params = {
        TableName: usersTable,
        Item: {
          userId,
          PK: `USER#${userId}`,
          SK: `METADATA#${userId}`,
          nome,
          email,
          senha: hashedSenha,
          telefone_whatsapp,
          created_at: timestamp,
          updated_at: timestamp,
        },
      };

      await dynamo.put(params).promise();

      res
        .status(201)
        .json({ message: "Usuário registrado com sucesso.", userId });
    } catch (error) {
      console.error(error);
      res.status(500).json({ message: "Erro ao registrar usuário." });
    }
  }
);

// Rota para login de usuário
app.post(
  "/login",
  [
    body("email").isEmail().withMessage("Email inválido."),
    body("senha").notEmpty().withMessage("Senha é obrigatória."),
  ],
  async (req, res) => {
    // Validação dos dados
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { email, senha } = req.body;

    const params = {
      TableName: usersTable,
      IndexName: "EmailIndex",
      KeyConditionExpression: "email = :email",
      ExpressionAttributeValues: {
        ":email": email,
      },
    };

    try {
      const result = await dynamo.query(params).promise();
      if (result.Items.length === 0) {
        return res.status(404).json({ message: "Usuário não encontrado." });
      }

      const user = result.Items[0];
      const isValid = await bcrypt.compare(senha, user.senha);

      if (!isValid) {
        return res.status(401).json({ message: "Senha inválida." });
      }

      // Gerar o token JWT
      const token = jwt.sign(
        { id: user.userId, email: user.email },
        process.env.JWT_SECRET,
        { expiresIn: "1h" }
      );

      res.status(200).json({ token });
    } catch (error) {
      console.error(error);
      res.status(500).json({ message: "Erro no login." });
    }
  }
);

module.exports.app = serverless(app);

module.exports.googleCalendarAuth = async (event) => {
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: ["https://www.googleapis.com/auth/calendar"],
  });

  return {
    statusCode: 302,
    headers: {
      Location: authUrl,
    },
  };
};

module.exports.createEvent = async (event) => {
  const userId = "51809be2-4de3-43bf-9e68-49c6aee391d3";

  // Recuperar token do banco de dados
  const params = {
    TableName: process.env.USERS_TABLE,
    Key: { userId },
  };

  const result = await dynamo.get(params).promise();

  console.log("Result:", result);
  if (!result.Item || !result.Item.googleTokens) {
    return {
      statusCode: 401,
      body: JSON.stringify({ error: "Usuário não autenticado no Google." }),
    };
  }

  const tokens = result.Item.googleTokens;

  // Configurar o cliente OAuth2 com os tokens
  oauth2Client.setCredentials(tokens);

  // Dados do evento
  const { summary, location, description, start, end } = JSON.parse(event.body);

  try {
    const calendar = google.calendar({ version: "v3", auth: oauth2Client });
    const response = await calendar.events.insert({
      calendarId: "primary",
      resource: {
        summary,
        location,
        description,
        start: { dateTime: start },
        end: { dateTime: end },
      },
    });

    return {
      statusCode: 200,
      body: JSON.stringify(response.data),
    };
  } catch (error) {
    console.error("Erro ao criar evento:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: "Erro ao criar evento no Google Calendar.",
      }),
    };
  }
};

module.exports.updateEvent = async (event) => {
  const userId = "51809be2-4de3-43bf-9e68-49c6aee391d3";

  // Recuperar token do banco de dados
  const params = {
    TableName: process.env.USERS_TABLE,
    Key: { userId },
  };

  const result = await dynamo.get(params).promise();

  if (!result.Item || !result.Item.googleTokens) {
    return {
      statusCode: 401,
      body: JSON.stringify({ error: "Usuário não autenticado no Google." }),
    };
  }

  const tokens = result.Item.googleTokens;

  // Configurar o cliente OAuth2 com os tokens
  oauth2Client.setCredentials(tokens);

  // Dados do evento
  const { id } = event.pathParameters;
  const { summary, location, description, start, end } = JSON.parse(event.body);

  try {
    const calendar = google.calendar({ version: "v3", auth: oauth2Client });
    const response = await calendar.events.update({
      calendarId: "primary",
      eventId: id,
      resource: {
        summary,
        location,
        description,
        start: { dateTime: start },
        end: { dateTime: end },
      },
    });

    return {
      statusCode: 200,
      body: JSON.stringify(response.data),
    };
  } catch (error) {
    console.error("Erro ao atualizar evento:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: "Erro ao atualizar evento no Google Calendar.",
      }),
    };
  }
};

module.exports.listEvents = async (event) => {
  const userId = "51809be2-4de3-43bf-9e68-49c6aee391d3";

  await ensureValidToken(userId);

  // Recuperar token do banco de dados
  const params = {
    TableName: process.env.USERS_TABLE,
    Key: { userId },
  };

  const result = await dynamo.get(params).promise();
  if (!result.Item || !result.Item.googleTokens) {
    return {
      statusCode: 401,
      body: JSON.stringify({ error: "Usuário não autenticado no Google." }),
    };
  }

  const tokens = result.Item.googleTokens;

  // Configurar o cliente OAuth2 com os tokens
  oauth2Client.setCredentials(tokens);

  try {
    const calendar = google.calendar({ version: "v3", auth: oauth2Client });

    const now = new Date();
    const currentYear = now.getFullYear();

    const response = await calendar.events.list({
      calendarId: "primary",
      maxResults: 2500,
      singleEvents: true,
      orderBy: "startTime",
      timeMin: new Date(currentYear, 0, 1).toISOString(),
      timeMax: new Date(currentYear + 1, 0, 1).toISOString(),
    });

    return {
      statusCode: 200,
      body: JSON.stringify(response.data.items),
    };
  } catch (error) {
    console.error("Erro ao listar eventos:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Erro ao listar eventos." }),
    };
  }
};

module.exports.deleteEvent = async (event) => {
  const { id } = event.pathParameters;

  const calendar = google.calendar({ version: "v3", auth: oauth2Client });
  await calendar.events.delete({
    calendarId: "primary",
    eventId: id,
  });

  return {
    statusCode: 204,
  };
};

module.exports.oauth2callback = async (event) => {
  const querystring = require("querystring");
  console.log("Query Params:", event.queryStringParameters);
  const code = event.queryStringParameters.code;

  try {
    // Obter tokens do Google usando o código de autorização
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    const userId = "51809be2-4de3-43bf-9e68-49c6aee391d3";

    // Salvar tokens no banco de dados
    await saveTokenToDB(userId, tokens);

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: "Autenticação realizada com sucesso!",
        tokens,
      }),
    };
  } catch (error) {
    console.error("Erro ao processar o código de autorização:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Erro ao autenticar com o Google." }),
    };
  }
};

const saveTokenToDB = async (userId, tokens) => {
  const params = {
    TableName: process.env.USERS_TABLE,
    Key: { userId },
    UpdateExpression: "SET googleTokens = :tokens",
    ExpressionAttributeValues: {
      ":tokens": tokens,
    },
  };
  await dynamo.update(params).promise();
};

module.exports.checkEvents = async () => {
  const userId = "51809be2-4de3-43bf-9e68-49c6aee391d3";

  try {
    await ensureValidToken(userId);
  } catch (error) {
    console.error("Erro na validação do token:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: "Erro na validação do token do Google.",
      }),
    };
  }

  // Recuperar token do banco de dados
  const params = {
    TableName: process.env.USERS_TABLE,
    Key: { userId },
  };

  const result = await dynamo.get(params).promise();
  if (!result.Item || !result.Item.googleTokens) {
    console.error("Usuário não autenticado no Google.");
    return;
  }

  const tokens = result.Item.googleTokens;

  // Configurar o cliente OAuth2 com os tokens
  oauth2Client.setCredentials(tokens);

  try {
    const calendar = google.calendar({ version: "v3", auth: oauth2Client });

    const now = new Date();
    const currentYear = now.getFullYear();

    const response = await calendar.events.list({
      calendarId: "primary",
      maxResults: 2500,
      singleEvents: true,
      orderBy: "startTime",
      timeMin: new Date(currentYear, 0, 1).toISOString(),
      timeMax: new Date(currentYear + 1, 0, 1).toISOString(),
    });
    const events = response.data.items;

    // Uso do loop for...of para aguardar cada envio
    for (const event of events) {
      const eventDate = new Date(event.start.dateTime || event.start.date);

      // Calcula 7 dias e 2 dias antes do evento
      const sevenDaysBefore = new Date(eventDate);
      sevenDaysBefore.setDate(eventDate.getDate() - 7);

      const twoDaysBefore = new Date(eventDate);
      twoDaysBefore.setDate(eventDate.getDate() - 2);

      const fifteenDaysAfter = new Date(eventDate);
      fifteenDaysAfter.setDate(eventDate.getDate() + 15);

      const formattedDate = eventDate.toLocaleDateString("pt-BR");
      const formattedTime = eventDate.toLocaleTimeString("pt-BR", {
        hour: "2-digit",
        minute: "2-digit",
        timeZone: event.start.timeZone,
      });

      // Extraindo as informações do cliente
      const clientInfo = extractClientInfo(event.description);
      if (!clientInfo.phone) {
        console.error(
          "Número de telefone não encontrado na descrição:",
          event.description
        );
        continue;
      }

      // Verifica se a data atual é 7 dias antes do evento
      if (now.toDateString() === sevenDaysBefore.toDateString()) {
        // Envia o template para 7 dias antes (template id HXc0b6a01cb6c702c1ce00a9f241f692d4)
        await sendTemplateMessage(
          clientInfo.phone,
          {
            1: clientInfo.name || "Cliente",
            2: formattedDate,
            3: formattedTime,
          },
          "HXc0b6a01cb6c702c1ce00a9f241f692d4"
        );
      }
      // Se não, verifica se a data atual é 2 dias antes do evento
      else if (now.toDateString() === twoDaysBefore.toDateString()) {
        // Envia o template para 2 dias antes (template id HX8ed3f6db3846d650fa7e1e09ca24cc48)
        await sendTemplateMessage(
          clientInfo.phone,
          {
            1: clientInfo.name || "Cliente",
            2: formattedDate,
            3: formattedTime,
          },
          "HX8ed3f6db3846d650fa7e1e09ca24cc48"
        );
      }

      if (now.toDateString() === fifteenDaysAfter.toDateString()) {
        // Inicia o fluxo do questionário enviando o template inicial
        // Por exemplo, utilizando um template que contém o botão "Responder Questionário"
        await sendTemplateMessage(
          clientInfo.phone,
          { 1: clientInfo.name || "Cliente" },
          "HX1bcdffa59bc761ad22e9e60def194080"
        );
      }
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ message: "Ok" }),
    };
  } catch (error) {
    console.error("Erro ao verificar eventos:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Erro ao verificar eventos." }),
    };
  }
};

module.exports.demoReply = async (event) => {
  const querystring = require("querystring");
  const bodyParams = querystring.parse(event.body);
  const from = bodyParams.From; // Número do paciente
  const nutritionistNumber = "+553195316802";

  // Extrai o ButtonPayload se existir, senão utiliza o Body
  const responseId = (bodyParams.ButtonPayload || bodyParams.Body || "")
    .toLowerCase()
    .trim();

  // Se o usuário clicar no botão "Responder Questionário" (id: resp_quest), inicia o fluxo
  if (responseId === "resp_quest") {
    await saveSurveyState(from, { currentQuestion: 0, responses: {} });
    await handleSurveyResponse(from, ""); // Envia a primeira pergunta
  }
  // Se for uma resposta para confirmação/cancelamento de consulta
  else if (
    responseId === "confirm" ||
    responseId === "cancel" ||
    responseId === "confirm_seven" ||
    responseId === "cancel_seven"
  ) {
    if (responseId === "confirm") {
      await sendWhatsAppTextMessage(from, "Sua consulta foi confirmada! ✅");
      await sendTemplateMessage(
        nutritionistNumber,
        { 1: from, 2: "confirmou" },
        "HX63a1d3ac2863fb13dd811dee40ced592"
      );
    } else if (responseId === "cancel") {
      await sendWhatsAppTextMessage(
        from,
        "Sua consulta foi cancelada. Em breve entraremos em contato com as opções de reagendamento."
      );
      await sendTemplateMessage(
        nutritionistNumber,
        { 1: from, 2: "cancelou" },
        "HX63a1d3ac2863fb13dd811dee40ced592"
      );
    } else if (responseId === "confirm_seven") {
      await sendWhatsAppTextMessage(
        from,
        "Você confirmou seu pré-agendamento. Aguarde nossa confirmação!"
      );
      await sendTemplateMessage(
        nutritionistNumber,
        { 1: from, 2: "confirmou" },
        "HX395c25bc3600cc005e8f8b80f142da06"
      );
    } else if (responseId === "cancel_seven") {
      await sendWhatsAppTextMessage(
        from,
        "Você cancelou seu pré-agendamento. Em breve, entraremos em contato para reagendamento."
      );
      await sendTemplateMessage(
        nutritionistNumber,
        { 1: from, 2: "cancelou" },
        "HX395c25bc3600cc005e8f8b80f142da06"
      );
    }
  }
  // Caso contrário, trata a resposta como parte do questionário
  else {
    await sendWhatsAppTextMessage(
      from,
      "Este número é exclusivo para notificações de consultas. " +
        "Por favor, utilize apenas as opções disponíveis (Confirmar ou Cancelar). " +
        "Qualquer outra solicitação não será reconhecida. Para assuntos diferentes ou reagendamento entre em contato: (31) 995316802."
    );
    // await handleSurveyResponse(from, bodyParams.Body || "");
  }

  return {
    statusCode: 200,
    body: JSON.stringify({ message: "Mensagem processada." }),
  };
};
async function listEventsForDate(startOfDay, endOfDay) {
  try {
    const calendar = google.calendar({ version: "v3", auth: oauth2Client });
    const response = await calendar.events.list({
      calendarId: "primary",
      maxResults: 2500,
      singleEvents: true,
      orderBy: "startTime",
      timeMin: startOfDay.toISOString(),
      timeMax: endOfDay.toISOString(),
    });
    return response.data.items || [];
  } catch (error) {
    console.error("Erro ao buscar eventos para o dia:", error);
    return [];
  }
}

async function getAvailableSlotsForDate(date) {
  // Agenda fixa (horários pré-definidos)
  const scheduleByDay = {
    1: [
      // Segunda-feira
      { start: "08:00", end: "12:00" },
      { start: "14:00", end: "17:00" },
    ],
    2: [
      // Terça-feira
      { start: "17:00", end: "21:00" },
    ],
    3: [
      // Quarta-feira
      { start: "13:00", end: "17:00" },
    ],
    4: [
      // Quinta-feira
      { start: "07:00", end: "12:00" },
      { start: "17:00", end: "20:00" },
    ],
    5: [
      // Sexta-feira
      { start: "17:00", end: "19:00" },
    ],
    6: [
      // Sábado
      { start: "07:00", end: "12:00" },
    ],
    // Domingo (0) não tem atendimento
  };

  // Obter o dia da semana (0 = Domingo, 1 = Segunda, etc.)
  const dayOfWeek = date.getDay();
  // Se não houver agenda definida para esse dia, retorna vazio
  if (!scheduleByDay[dayOfWeek]) {
    return [];
  }

  // Define início e fim do dia para a consulta dos eventos
  const startOfDay = new Date(date);
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(date);
  endOfDay.setHours(23, 59, 59, 999);

  // Busca eventos já agendados para o dia
  const events = await listEventsForDate(startOfDay, endOfDay);

  // Função auxiliar para converter "HH:MM" em um objeto Date no mesmo dia
  function convertToDate(timeStr) {
    const [h, m] = timeStr.split(":").map(Number);
    const d = new Date(date);
    d.setHours(h, m, 0, 0);
    return d;
  }

  let availableSlots = [];
  // Itera sobre os slots definidos para o dia
  for (const slot of scheduleByDay[dayOfWeek]) {
    const slotStart = convertToDate(slot.start);
    const slotEnd = convertToDate(slot.end);

    // Verifica se algum evento se sobrepõe a esse slot
    let isFree = true;
    for (const event of events) {
      // Alguns eventos podem ser o dia inteiro (all-day); considere isso se necessário
      const eventStart = new Date(event.start.dateTime || event.start.date);
      const eventEnd = new Date(event.end.dateTime || event.end.date);

      // Se houver sobreposição entre o slot e o evento, o slot não está livre
      if (eventStart < slotEnd && eventEnd > slotStart) {
        isFree = false;
        break;
      }
    }

    if (isFree) {
      availableSlots.push(`${slot.start} - ${slot.end}`);
    }
  }
  return availableSlots;
}

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

async function saveSurveyState(from, state) {
  const params = {
    TableName: "surveyStates",
    Item: { phone: from, ...state },
  };
  await dynamo.put(params).promise();
}

// Função para enviar a próxima pergunta com base no número da pergunta
async function sendNextQuestion(from, questionNumber) {
  switch (questionNumber) {
    case 1:
      await sendWhatsAppTextMessage(
        from,
        "Pergunta 1:\nDe modo geral, qual nota (0 a 5) você daria para sua disciplina no plano alimentar? (Responda '0 a 3' ou '4 a 5')"
      );
      break;
    case 2:
      await sendWhatsAppTextMessage(
        from,
        "Pergunta 2:\nEm que quesito você está tendo mais dificuldade? Responda:\n1 - Durante a semana\n2 - Fim de semana\n3 - Os dois"
      );
      break;
    case 3:
      await sendWhatsAppTextMessage(
        from,
        "Pergunta 3:\nNo quesito Sensação de fome, qual nota (0 a 5) você daria?"
      );
      break;
    case 4:
      await sendWhatsAppTextMessage(
        from,
        "Pergunta 4:\nCom relação à adesão à dieta, dê uma nota de 0 a 5, onde:\n0 - Não está aderindo\n1 - Quase não está aderindo\n2 - Pouco\n3 - Aos poucos\n4 - Já aderiu, mas pode melhorar\n5 - Aderência entre 90% e 100%"
      );
      break;
    case 5:
      await sendWhatsAppTextMessage(
        from,
        "Pergunta 5:\nComo tem estado sua motivação para seguir o Plano Alimentar? Pontue de 0 a 5."
      );
      break;
    default:
      await sendWhatsAppTextMessage(
        from,
        "Obrigado por responder o questionário! Em breve entraremos em contato."
      );
      break;
  }
}

// Função que processa a resposta do usuário e avança o fluxo do questionário
async function handleSurveyResponse(from, message) {
  let state = await getSurveyState(from);

  // Se o fluxo ainda não foi iniciado, inicie com a primeira pergunta.
  if (state.currentQuestion === 0) {
    state.currentQuestion = 1;
    state.responses = {};
    await saveSurveyState(from, state);
    await sendNextQuestion(from, state.currentQuestion);
    return;
  }

  // Validação da resposta com base na pergunta atual.
  let valid = true;
  let errorMessage = "";

  switch (state.currentQuestion) {
    case 1:
      // Valida se a resposta é numérica e está entre 0 e 5.
      const num1 = parseInt(message, 10);
      if (isNaN(num1) || num1 < 0 || num1 > 5) {
        valid = false;
        errorMessage =
          "Resposta inválida para a Pergunta 1. Por favor, responda com um número entre 0 e 5.";
      }
      break;
    case 2:
      // Espera resposta: "1", "2" ou "3"
      if (message !== "1" && message !== "2" && message !== "3") {
        valid = false;
        errorMessage =
          "Resposta inválida para a Pergunta 2. Por favor, responda com '1', '2' ou '3'.";
      }
      break;
    case 3:
    case 4:
    case 5:
      // Valida resposta numérica entre 0 e 5.
      const num = parseInt(message, 10);
      if (isNaN(num) || num < 0 || num > 5) {
        valid = false;
        errorMessage =
          "Resposta inválida. Por favor, responda com um número entre 0 e 5.";
      }
      break;
    default:
      break;
  }

  // Se a resposta for inválida, informe e reenvie a mesma pergunta sem avançar.
  if (!valid) {
    await sendWhatsAppTextMessage(from, errorMessage);
    await sendNextQuestion(from, state.currentQuestion);
    return;
  }

  // Se a resposta for válida, registra a resposta da pergunta atual.
  const current = state.currentQuestion;
  state.responses[`question${current}`] = message;
  state.currentQuestion = current + 1;
  await saveSurveyState(from, state);

  // Se ainda há perguntas, envia a próxima; caso contrário, finaliza o fluxo.
  if (state.currentQuestion <= 5) {
    await sendNextQuestion(from, state.currentQuestion);
  } else {
    await sendWhatsAppTextMessage(
      from,
      "Obrigado por responder o questionário! Em breve entraremos em contato."
    );
  }
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
  console.log("targetOffsetDays:", targetOffsetDays);
  console.log("targetDate:", targetDate.toISOString());
  console.log("startOfDay:", startOfDay.toISOString());
  console.log("endOfDay:", endOfDay.toISOString());

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
  getMessageVariables
) {
  let messagesSent = 0;
  for (const event of events) {
    const clientInfo = extractClientInfo(event.description);
    if (!clientInfo.phone) {
      console.error("Telefone não encontrado para o evento:", event.id);
      continue;
    }
    const variables = getMessageVariables(event);
    await sendTemplateMessage(clientInfo.phone, variables, templateId);
    await markEventAsNotified(event.id, notificationType);
    messagesSent++;
  }
  return messagesSent;
}

// Lista os eventos para confirmação 2 dias (que ainda não receberam notificação "notified_2days")
module.exports.listConfirmation2Days = async () => {
  try {
    const events = await listEventsForNotification("notified_2days", 2);
    return {
      statusCode: 200,
      body: JSON.stringify({ events }),
    };
  } catch (error) {
    console.error("Erro ao listar eventos 2 dias:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Erro ao listar eventos 2 dias." }),
    };
  }
};

// Envia as mensagens de confirmação para os eventos listados
module.exports.sendConfirmation2Days = async () => {
  try {
    const userId = "51809be2-4de3-43bf-9e68-49c6aee391d3";
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
      }
    );
    return {
      statusCode: 200,
      body: JSON.stringify({
        message: `Processadas ${messagesSent} mensagens de confirmação (2 dias).`,
      }),
    };
  } catch (error) {
    console.error("Erro ao enviar confirmações 2 dias:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Erro ao enviar confirmações 2 dias." }),
    };
  }
};

// Lista os eventos para confirmação 7 dias (que ainda não receberam notificação "notified_7days")
module.exports.listConfirmation7Days = async () => {
  try {
    const events = await listEventsForNotification("notified_7days", 7);
    return {
      statusCode: 200,
      body: JSON.stringify({ events }),
    };
  } catch (error) {
    console.error("Erro ao listar eventos 7 dias:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Erro ao listar eventos 7 dias." }),
    };
  }
};

// Envia as mensagens de confirmação para os eventos listados
module.exports.sendConfirmation7Days = async () => {
  try {
    const userId = "51809be2-4de3-43bf-9e68-49c6aee391d3";
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
      }
    );
    return {
      statusCode: 200,
      body: JSON.stringify({
        message: `Processadas ${messagesSent} mensagens de confirmação (7 dias).`,
      }),
    };
  } catch (error) {
    console.error("Erro ao enviar confirmações 7 dias:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Erro ao enviar confirmações 7 dias." }),
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

// Envia as mensagens de suporte para os eventos listados
module.exports.sendSupportNotifications = async () => {
  try {
    const events = await listEventsForNotification("notified_support", -15);
    const messagesSent = await sendNotificationsForEvents(
      events,
      "notified_support",
      "HX1bcdffa59bc761ad22e9e60def194080", // ID do template para suporte
      (event) => {
        // Para suporte, talvez seja suficiente enviar apenas o nome do cliente
        const clientInfo = extractClientInfo(event.description);
        return {
          1: clientInfo.name || "Cliente",
        };
      }
    );
    return {
      statusCode: 200,
      body: JSON.stringify({
        message: `Processadas ${messagesSent} mensagens de suporte.`,
      }),
    };
  } catch (error) {
    console.error("Erro ao enviar notificações de suporte:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: "Erro ao enviar notificações de suporte.",
      }),
    };
  }
};
