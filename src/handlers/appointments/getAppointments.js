// handlers/appointments.js
const { cleanAndListAppointments } = require('../../lib/calendar')
const { authorize } = require('../../middleware/authorize')

async function getAppointments(event) {
  const nutriId = event.requestContext.authorizer.nutriId
  try {
    const items = await cleanAndListAppointments(nutriId)
    return { statusCode: 200, body: JSON.stringify(items) }
  } catch (err) {
    console.error(err)
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) }
  }
}

module.exports.getAppointments = authorize(getAppointments)
