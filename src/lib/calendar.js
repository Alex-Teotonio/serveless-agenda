// src/lib/calendar.js
const AWS = require('aws-sdk');
const { google } = require('googleapis');
const dynamo = new AWS.DynamoDB.DocumentClient();

/**
 * Returns an authenticated Google Calendar client for the given userId.
 */
async function getCalendarClient(userId) {
  console.log(`getCalendarClient: carregando tokens para userId=${userId}`);
  const { Item } = await dynamo.get({
    TableName: process.env.USERS_TABLE,
    Key: { userId }
  }).promise();

  if (!Item || !Item.googleTokens) {
    throw new Error(`Usuário ${userId} não autenticado no Google`);
  }

  const oAuth2Client = new google.auth.OAuth2();
  oAuth2Client.setCredentials(Item.googleTokens);
  console.log(`getCalendarClient: credenciais setadas para userId=${userId}`);

  return google.calendar({ version: 'v3', auth: oAuth2Client });
}

/**
 * Query Dynamo, verify existence in Google Calendar, and clean up missing events.
 * Returns only the live appointments.
 */
async function cleanAndListAppointments(nutriId) {
  console.log(`cleanAndListAppointments: iniciando para nutriId=${nutriId}`);

  // 1) Query no Dynamo
  const queryParams = {
    TableName: process.env.PATIENTS_TABLE,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
    ExpressionAttributeValues: {
      ':pk': `NUTRICIONISTA#${nutriId}`,
      ':sk': 'CONSULTA#'
    }
  };
  const { Items = [] } = await dynamo.query(queryParams).promise();
  console.log(`cleanAndListAppointments: encontrados ${Items.length} registros no Dynamo`);

  // 2) Google Calendar client
  const calendar = await getCalendarClient(nutriId);

  // 3) Verificação + remoção
  const live = [];
  for (const item of Items) {
    const eventId = item.SK.replace('CONSULTA#', '');
    try {
      const { data: calEvent } = await calendar.events.get({ calendarId: 'primary', eventId });
      if (calEvent.status === 'cancelled') {
        console.warn(`  ⚠ eventId=${eventId} está CANCELLED. Deletando do Dynamo.`);
        await dynamo.delete({
          TableName: process.env.PATIENTS_TABLE,
          Key: { PK: `NUTRICIONISTA#${nutriId}`, SK: item.SK }
        }).promise();
      } else {
        live.push(item);
      }
    } catch (err) {
      if (err.code === 404) {
        console.warn(`  ⚠ eventId=${eventId} não encontrado (404). Deletando do Dynamo.`);
        await dynamo.delete({
          TableName: process.env.PATIENTS_TABLE,
          Key: { PK: `NUTRICIONISTA#${nutriId}`, SK: item.SK }
        }).promise();
      } else {
        console.error(`  ❌ erro ao buscar eventId=${eventId}:`, err);
        throw err;
      }
    }

  }
  console.log(`cleanAndListAppointments: retornando ${live.length} eventos válidos`);
  return live;
}

module.exports = {
  getCalendarClient,
  cleanAndListAppointments
};
