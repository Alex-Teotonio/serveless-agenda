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

// Rota de exemplo
app.get("/", (req, res) => {
  res.send("Hello from Agendazap Backend!");
});

// Rota de Teste
app.get("/test", (req, res) => {
  res.json({ message: "Endpoint de teste funcionando corretamente!" });
});

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

    // Verificar se o email já está em uso
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
  const { id } = event.pathParameters;
  const { summary, location, description, start, end } = JSON.parse(event.body);

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
