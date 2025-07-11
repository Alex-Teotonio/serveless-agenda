const AWS = require("aws-sdk");
const { v4: uuidv4 } = require("uuid");

const dynamo = new AWS.DynamoDB.DocumentClient();

module.exports.register = async (event) => {
  const { nome, email, senha, telefone_whatsapp } = JSON.parse(event.body || "{}");

  if (!email || !senha || !nome || !telefone_whatsapp) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "Todos os campos são obrigatórios" }),
    };
  }

  const userId = uuidv4();

  const item = {
    userId,
    nome,
    email,
    telefone_whatsapp,
    password: senha, // Em produção: usar bcrypt
    criadoEm: new Date().toISOString(),
  };

  await dynamo
    .put({
      TableName: process.env.USERS_TABLE,
      Item: item,
    })
    .promise();

  return {
    statusCode: 201,
    body: JSON.stringify({ message: "Usuário criado com sucesso", userId }),
  };
};
