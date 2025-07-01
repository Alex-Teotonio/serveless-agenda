const AWS = require("aws-sdk");
const { v4: uuidv4 } = require("uuid");
const { authorize } = require("../../middleware/authorize");

const dynamo = new AWS.DynamoDB.DocumentClient();

const NUTRI_PREFIX = "NUTRICIONISTA#";
const PATIENT_PREFIX = "PACIENTE#";

const createPatient = async (event) => {
  const { nome, telefone_whatsapp, email, dataNascimento, observacoes } = JSON.parse(event.body || "{}");
  const nutriId = event.requestContext.authorizer.nutriId;

  if (!nome || !telefone_whatsapp || !email) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "Campos obrigatórios: nome, telefone_whatsapp, email." }),
    };
  }

  const patientId = uuidv4();
  const PK = `${NUTRI_PREFIX}${nutriId}`;
  const SK = `${PATIENT_PREFIX}${patientId}`;

  const newItem = {
    PK,
    SK,
    nome,
    telefone_whatsapp,
    email,
    dataNascimento: dataNascimento || null,
    observacoes: observacoes || "",
    criadoEm: new Date().toISOString(),
  };

  await dynamo.put({
    TableName: process.env.PATIENTS_TABLE,
    Item: newItem,
  }).promise();

  return {
    statusCode: 201,
    body: JSON.stringify({ message: "Paciente criado com sucesso", paciente: newItem }),
  };
};

module.exports.createPatient = authorize(createPatient);
