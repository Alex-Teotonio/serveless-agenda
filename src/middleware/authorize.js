const jwt = require("jsonwebtoken");

const JWT_SECRET = process.env.JWT_SECRET;

const authorize = (handler) => async (event, ctx) => {
  let authHeader = event.headers?.authorization;
  let token =
    authHeader?.startsWith("Bearer ")
      ? authHeader.replace("Bearer ", "")
      : event.queryStringParameters?.token;

  if (!token) {
    return { statusCode: 401, body: JSON.stringify({ error: "Token ausente ou inválido" }) };
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    event.requestContext = {
      ...event.requestContext,
      authorizer: { nutriId: decoded.nutriId },
    };
    return handler(event, ctx);
  } catch {
    return { statusCode: 403, body: JSON.stringify({ error: "Token inválido ou expirado" }) };
  }
};

module.exports = { authorize };
