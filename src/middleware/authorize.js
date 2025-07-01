const jwt = require("jsonwebtoken");

const JWT_SECRET = process.env.JWT_SECRET;

const authorize = (handler) => {
  return async (event, context) => {
    const authHeader = event.headers?.Authorization || event.headers?.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return {
        statusCode: 401,
        body: JSON.stringify({ error: "Token ausente ou inválido" }),
      };
    }

    try {
      const token = authHeader.replace("Bearer ", "").trim();
      const decoded = jwt.verify(token, JWT_SECRET);

      // Injeta o nutriId no contexto da requisição
      event.requestContext = {
        ...event.requestContext,
        authorizer: {
          nutriId: decoded.nutriId,
        },
      };

      return handler(event, context);
    } catch (err) {
      return {
        statusCode: 403,
        body: JSON.stringify({ error: "Token inválido ou expirado" }),
      };
    }
  };
};

module.exports = { authorize };
