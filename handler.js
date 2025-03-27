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

  try {
    const msg = await client.messages.create({
      from: "whatsapp:+14155238886",
      body: message,
      to: `whatsapp:${to}`,
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

      // Calcula dois dias antes do evento
      const twoDaysBefore = new Date(eventDate);
      twoDaysBefore.setDate(eventDate.getDate() - 2);

      if (now.toDateString() === twoDaysBefore.toDateString()) {
        const phoneFromDescription = extractPhoneNumber(event.description);
        console.log("Telefone:", phoneFromDescription);

        if (phoneFromDescription) {
          const formattedDate = eventDate.toLocaleDateString("pt-BR");
          const formattedTime = eventDate.toLocaleTimeString("pt-BR", {
            hour: "2-digit",
            minute: "2-digit",
            timeZone: event.start.timeZone,
          });
          // Aguarda o envio da mensagem antes de continuar
          await sendWhatsAppMessage(phoneFromDescription, {
            1: "Alex",
            2: formattedDate,
            3: formattedTime,
          });
        } else {
          console.error(
            "Número de telefone não encontrado na descrição do evento:",
            event.description
          );
        }
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
  // Faz o parse do body recebido (formato x-www-form-urlencoded)
  const bodyParams = querystring.parse(event.body);

  const from = bodyParams.From;
  const messageText = (bodyParams.Body || "").toLowerCase().trim();

  if (messageText === "confirmar") {
    await sendWhatsAppTextMessage(from, "Sua consulta foi confirmada! ✅");
  } else if (messageText === "cancelar") {
    // Envia mensagem informando cancelamento e perguntando se deseja reagendar
    await sendWhatsAppTextMessage(
      "+3197508819",
      "Seu agendamento foi cancelado. Em breve entraremos em contato com as opções de reagendamento."
    );
    // (Opcional) Notificar a nutricionista sobre o cancelamento
    // await sendWhatsAppTextMessage(
    //   "+553197508819",
    //   "Desculpe, não há horários disponíveis para reagendamento amanhã."
    // );
  } else if (messageText === "sim") {
    // Exemplo: buscamos os horários disponíveis para amanhã
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const availableSlots = await getAvailableSlotsForDate(tomorrow);

    if (availableSlots.length > 0) {
      // Cria uma mensagem listando as opções
      let message = `Horários disponíveis para ${tomorrow.toLocaleDateString()}:\n`;
      availableSlots.forEach((slot, index) => {
        message += `${index + 1} - ${slot}\n`;
      });
      message += "Por favor, responda com o número da opção desejada.";
      await sendWhatsAppTextMessage("+553197508819", message);
    } else {
      await sendWhatsAppTextMessage(
        "+553197508819",
        "Desculpe, não há horários disponíveis para reagendamento amanhã."
      );
    }
  } else if (/^[1-9]\d*$/.test(messageText)) {
    // Se o paciente enviar um número, isso pode indicar que ele escolheu um slot.
    // Aqui você pode armazenar a escolha, confirmar o reagendamento e/ou notificar a nutricionista.
    // Para simplicidade, apenas enviamos uma mensagem de confirmação.
    await sendWhatsAppTextMessage(
      "+553197508819",
      `Você selecionou a opção ${messageText}. Nossa equipe entrará em contato para confirmar o novo horário.`
    );
    // (Opcional) Notifique a nutricionista sobre a escolha do paciente.
  } else {
    await sendWhatsAppTextMessage(
      "+553197508819",
      "Desculpe, não entendi sua mensagem. Por favor, responda com 'confirmar', 'cancelar', 'sim' ou com o número da opção desejada."
    );
  }

  return {
    statusCode: 200,
    body: JSON.stringify({ message: "Mensagem processada com sucesso." }),
  };
};

// Fun��o auxiliar que retorna os hor�rios dispon�veis
function getAvailableSlots() {
  return (
    "Horários disponíveis:\n" +
    "Segunda: 08:00 - 12:00 e 14:00 - 17:00\n" +
    "Terça: 17:00 - 21:00\n" +
    "Quarta: 13:00 - 17:00\n" +
    "Quinta: 07:00 - 12:00 e 17:00 - 20:00\n" +
    "Sexta: 17:00 - 19:00\n" +
    "Sábado: 07:00 - 12:00"
  );
}

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

function extractPhoneNumber(description) {
  const regex = /Contato:\s*(\+?\d+)/i;
  const match = description && description.match(regex);
  if (match && match[1]) {
    // Remove o sinal de '+' se existir
    let phone = match[1].replace("+", "");
    // Se o número não começar com "55", adiciona "55" no início
    if (!phone.startsWith("+55")) {
      phone = "+55" + phone;
    }
    return phone;
  }
  return null;
}
