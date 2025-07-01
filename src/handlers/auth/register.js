const AWS = require("aws-sdk");
const { v4: uuidv4 } = require("uuid");

const dynamo = new AWS.DynamoDB.DocumentClient();

module.exports.register = async (event) => {
  const { email, password } = JSON.parse(event.body || "{}");

  if (!email || !password) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "Email e senha s�o obrigat�rios" }),
    };
  }

  const userId = uuidv4();

  const item = {
    userId,
    email,
    password, // ? Em produ��o, voc� deve hashear com bcrypt
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
    body: JSON.stringify({ message: "Usu�rio criado com sucesso", userId }),
  };
};
