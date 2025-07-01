const AWS = require("aws-sdk");
const { authorize } = require("../../middleware/authorize");

// dynamo
const dynamo = new AWS.DynamoDB.DocumentClient();

const getPatients = async (event) => {
  const nutriId = event.requestContext.authorizer.nutriId;

  const params = {
    TableName: process.env.PATIENTS_TABLE,
    KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
    ExpressionAttributeValues: {
      ":pk": `NUTRICIONISTA#${nutriId}`,
      ":sk": "PACIENTE#",
    },
  };

  try {
    const result = await dynamo.query(params).promise();
    return {
      statusCode: 200,
      body: JSON.stringify(result.Items),
    };
  } catch (error) {
    console.error("Erro ao listar pacientes:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Erro ao listar pacientes" }),
    };
  }
};

module.exports.getPatients = authorize(getPatients);
