const AWS = require("aws-sdk");
const { authorize } = require("../../middleware/authorize");

const dynamo = new AWS.DynamoDB.DocumentClient();

const getAppointments = async (event) => {
  const nutriId = event.requestContext.authorizer.nutriId;

  const params = {
    TableName: process.env.PATIENTS_TABLE,      // usamos a mesma tabela onde gravamos CONSULTA#
    KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
    ExpressionAttributeValues: {
      ":pk": `NUTRICIONISTA#${nutriId}`,
      ":sk": "CONSULTA#",
    },
  };

  try {
    const result = await dynamo.query(params).promise();
    return {
      statusCode: 200,
      body: JSON.stringify(result.Items),
    };
  } catch (err) {
    console.error("Erro ao listar consultas:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Erro ao listar consultas" }),
    };
  }
};

module.exports.getAppointments = authorize(getAppointments);
