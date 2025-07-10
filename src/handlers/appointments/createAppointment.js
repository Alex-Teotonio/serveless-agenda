const AWS = require("aws-sdk");
const { google } = require("googleapis");
const { authorize } = require("../../middleware/authorize");

const dynamo = new AWS.DynamoDB.DocumentClient();
const calendar = google.calendar("v3");

const createAppointment = async (event) => {
  const nutriId = event.requestContext.authorizer.nutriId;
  const { pacienteId, summary, description, location, start, end } = JSON.parse(event.body);

  if (!pacienteId || !start || !end) {
    return {
      statusCode: 400,
      body: JSON.stringify({ message: "Campos obrigatórios: pacienteId, start, end" }),
    };
  }

  // Busca nome e telefone do paciente
  const pacienteParams = {
    TableName: process.env.PATIENTS_TABLE,
    Key: {
      PK: `NUTRICIONISTA#${nutriId}`,
      SK: pacienteId
    },
  };
  const pacienteResult = await dynamo.get(pacienteParams).promise();
  const paciente = pacienteResult.Item;

  if (!paciente) {
    return {
      statusCode: 404,
      body: JSON.stringify({ message: "Paciente não encontrado" }),
    };
  }

  const userParams = {
    TableName: process.env.USERS_TABLE,
    Key: { userId: nutriId }
  };

  const userResult = await dynamo.get(userParams).promise();
  const tokens = userResult.Item.googleTokens;

  if (!tokens) {
    return {
      statusCode: 403,
      body: JSON.stringify({ message: "Nutricionista não autenticado no Google" }),
    };
  }

  const oAuth2Client = new google.auth.OAuth2();
  oAuth2Client.setCredentials(tokens);

  try {
    // Cria o evento no Google Calendar
    const calendarEvent = await calendar.events.insert({
      auth: oAuth2Client,
      calendarId: "primary",
      requestBody: {
        summary,
        description: `Contato: ${paciente.telefone_whatsapp}\nPaciente: ${paciente.nome}${description ? `\n\n${description}` : ''}`,
        location,
        start: { 
          dateTime: "2025-07-12T10:00:00", 
          timeZone: "America/Sao_Paulo" 
        },
        end: { 
          dateTime: "2025-07-12T11:00:00", 
          timeZone: "America/Sao_Paulo" 
        }
        
      },
    });

    // Salva a consulta no DynamoDB
    const appointment = {
      PK: `NUTRICIONISTA#${nutriId}`,
      SK: `CONSULTA#${calendarEvent.data.id}`,
      pacienteId,
      summary,
      description,
      location,
      start,
      end,
      criadoEm: new Date().toISOString(),
    };

    await dynamo.put({
      TableName: process.env.PATIENTS_TABLE,
      Item: appointment
    }).promise();

    return {
      statusCode: 201,
      body: JSON.stringify({ message: "Consulta criada com sucesso", appointment }),
    };
  } catch (error) {
    console.error("Erro ao criar consulta:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Erro ao criar consulta" }),
    };
  }
};

module.exports.createAppointment = authorize(createAppointment);
