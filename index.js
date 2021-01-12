//addEventListener("fetch", event => {
//  return event.respondWith(processCronTrigger(event))
//})

addEventListener('scheduled', (event) => {
  event.waitUntil(processCronTrigger(event))
})

// capitalize first character and replace underscores for spaces
const normalize = (s) => {
  if (typeof s !== 'string') return ''
  return s.charAt(0).toUpperCase() + s.slice(1).replaceAll('_', ' ')
}

async function processCronTrigger(event) {
  const AUDIT_LOGS_SINCE =
    (await KV_AUDIT_LOGS.get('LAST_PROCESSED_AUDIT_LOG')) ||
    new Date().toISOString().slice(0, 10)

  const init = {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${SECRET_CLOUDFLARE_API_TOKEN}`,
    },
  }
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/audit_logs?per_page=10&since=${AUDIT_LOGS_SINCE}&direction=asc`,
    init,
  )
  const jsonResponse = await response.json()

  const filteredAuditLogs = filterAuditLogs(jsonResponse.result)

  if (filteredAuditLogs.length < 1) {
    return new Response('No audit logs to process.')
  }

  const slackResponse = await postSlackMessage(filteredAuditLogs)

  if (slackResponse.status !== 200) {
    return new Response(
      'Error during sending logs to Slack, will try again on next schedule.',
    )
  }

  await saveLastAuditLogTimestamp(filteredAuditLogs)
  //return new Response(JSON.stringify(jsonResponse))
  return new Response('OK')
}

async function saveLastAuditLogTimestamp(filteredAuditLogs) {
  const lastAuditLog = new Date(filteredAuditLogs.pop().when)
  const lastTimestamp = new Date(lastAuditLog.getTime() + 1000) // need one more second to skip last
  await KV_AUDIT_LOGS.put(
    'LAST_PROCESSED_AUDIT_LOG',
    lastTimestamp.toISOString(),
  )
}

// optional, todo: documment
function filterAuditLogs(auditLogs) {
  const filterResourceTypes = []
  if (filterResourceTypes.length > 0) {
    return auditLogs.filter((x) => {
      return !filterResourceTypes.includes(x.resource.type)
    })
  }
  return auditLogs
}

function getLogTime(timestamp) {
  return new Date(timestamp).toLocaleTimeString('cs-CZ', {
    timeZone: 'Europe/Prague',
  })
}

function generateSlackMessageBlocks(headline, contextList) {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: headline,
      },
    },
    {
      type: 'context',
      elements: contextList
        .filter((n) => n)
        .map((el) => {
          return {
            type: 'mrkdwn',
            text: el,
          }
        }),
    },
    {
      type: 'divider',
    },
  ]
}

function getResourceName(log) {
  let resName = ''
  switch (log.resource.type) {
    case 'DNS_record':
      resName = log.newValueJson ? log.newValueJson.name : log.oldValueJson.name
      break
    case 'pagerule':
      resName = log.metadata.pr_match
      break
    case 'script':
      resName = log.resource.id
      break
    case 'route':
      resName = log.metadata.pattern
      break
    case 'ratelimit' || 'firewallrules' || 'uarules':
      resName = log.newValueJson
        ? log.newValueJson.description
        : log.oldValueJson.description
      break
    default:
      return ''
  }
  return `\`${resName}\``
}

async function postSlackMessage(filteredAuditLogs) {
  let blocks = []
  filteredAuditLogs.forEach((log, i) => {
    blocks = blocks.concat(
      generateSlackMessageBlocks(
        `${getLogTime(log.when)}: *${normalize(
          log.resource.type,
        )}* ${getResourceName(log)} (${normalize(log.action.type)})`,
        [
          `*Actor*: ${log.actor.email}`,
          log.metadata.zone_name
            ? `*Zone*: ${log.metadata.zone_name}`
            : 'Account level',
          log.interface === 'UI' ? ':warning: UI' : undefined,
        ],
      ),
    )
  })

  const postToSlack = await fetch(SECRET_SLACK_WEBHOOK_URL, {
    body: JSON.stringify({ blocks: blocks }),
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  })

  return postToSlack
}
