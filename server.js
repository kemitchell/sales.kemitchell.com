var log = require('pino')()

process.on('SIGINT', trap)
process.on('SIGQUIT', trap)
process.on('SIGTERM', trap)
process.on('uncaughtException', function (exception) {
  log.error(exception, 'uncaughtException')
  close()
})

function trap (signal) {
  log.info({ signal }, 'signal')
  close()
}

function close () {
  log.info('closing')
  server.close(function () {
    log.info('closed')
    process.exit(0)
  })
}

var PASSWORD = process.env.PASSWORD
if (!PASSWORD) {
  log.error('no PASSWORD in env')
  process.exit(1)
}

var DOMAIN = process.env.DOMAIN || 'sales@kemitchell.com'
var FROM = process.env.FROM || 'form@' + DOMAIN
var TO = process.env.TO
if (!TO) {
  log.error('no TO in env')
  process.exit(1)
}
var MAILGUN_KEY = process.env.MAILGUN_KEY
if (!MAILGUN_KEY) {
  log.error('no MAILGUN_KEY in env')
  process.exit(1)
}

var addLogs = require('pino-http')({ logger: log })
var parseURL = require('url-parse')
var server = require('http').createServer(function (request, response) {
  addLogs(request, response)
  var parsed = parseURL(request.url, true)
  request.query = parsed.query
  var method = request.method
  if (method === 'GET') return get(request, response)
  if (method === 'POST') return post(request, response)
  response.statusCode = 405
  response.end()
})

function get (request, response) {
  var password = request.query.password
  if (!password) {
    response.statusCode = 401
    return response.end()
  }
  if (password !== PASSWORD) {
    response.statusCode = 403
    return response.end()
  }
  response.end(`
<!doctype html>
<html lang=en-US>
  <head>
    <meta charset=UTF-8>
    <meta name=viewport content=width=device-width,initial-scale=1>
    <title>Sales Intake</title>
    <link href=https://readable.kemitchell.com/all.css rel=stylesheet>
    <style>
label, button, input, textarea, select {
  display: block;
  width: 100%;
  box-sizing: border-box;
}
button, input, textarea, select {
  margin-bottom: 1rem;
  padding: 0.5rem;
}
    </style>
  </head>

  <body>
    <header role=banner>
      <h1>Sales Intake</h1>
    </header>

    <main role=main>
      <form action=/ method=post>
        <fieldset>
          <legend>Lead</legend>
          <label for=who>Who is the lead?</label>
          <input name=who type=text required>
          <label for=prior>Have we sold this company or corporate group before?</label>
          <select name=prior>
            <option value=yes>Yes</option>
            <option value=no>No</option>
            <option value=unsure>Not Sure</option>
          </select>
          <label for=where>Where are they based?</label>
          <input name=where type=text required>
        </fieldset>

        <fieldset>
          <legend>Opportunity</legend>
          <label for=money>How much money are we talking?</label>
          <input name=money type=text>
          <label for=needs>Any unusual needs on their part?</label>
          <textarea name=needs></textarea>
          <label for=grow>Is there unusually high potential for the dollar value of this deal to grow over time?</label>
          <textarea name=grow></textarea>
          <label for=affiliates>Are we aware of other business groups or corporate affiliates we can sell to?</label>
          <textarea name=affiliates></textarea>
          <label for=strategic>Is this lead strategically valuable in some other way?</label>
          <textarea name=strategic></textarea>
        </fieldset>

        <fieldset>
          <legend>Process</legend>
          <label for=legal>Is their legal already involved?</label>
          <select name=legal>
            <option value=yes>Yes</option>
            <option value=no>No</option>
          </select>
          <label for=>Have we received or responded to any questionnaires?  Please send me copies, and let me know who handled them.</label>
          <select name=questionnaires>
            <option value=yes>Yes</option>
            <option value=no>No</option>
          </select>
          <label for=>Is their budget or procurement process tied to a deadline, like the end of a quarter?</label>
          <input name=deadline type=text>
        </fieldset>

        <fieldset>
          <legend>Competition</legend>
          <label for=rfp>Are we participating in an RFP, beauty contest, or bake-off?</label>
          <select name=incumbent>
            <option value=RFP>RFP</option>
            <option value=bakeoff>Beauty Contest/Bake-Off</option>
            <option value=no>No</option>
          </select>
          <label for=competitor>Are they currently with a competitor?</label>
          <textarea name=competitor></textarea>
        </fieldset>

        <fieldset>
          <legend>Submit</legend>
          <label for=cc>Your E-Mail</label>
          <input name=cc type=email>
          <button type=submit>Submit</button>
        </fieldset>
      </form>
    </main>

    <footer role=contentinfo>&copy; Kyle E. Mitchell</footer>
  </body>
</html>
  `.trim())
}

/*
var fields = [
  'who',
  'prior',
  'where',
  'money',
  'needs',
  'grow',
  'affiliates',
  'strategic',
  'legal',
  'questionnaires',
  'deadline',
  'incumbent',
  'competitor',
  'cc',
]
*/

var Busboy = require('Busboy')
var fs = require('fs')
var runSeries = require('run-series')

function post (request, response) {
  var data = {}
  request.pipe(
    new Busboy({ headers: request.headers })
      .on('field', function (name, value) {
        data[name] = value.trim()
      })
      .on('finish', function () {
        var date = data.date = new Date().toISOString()
        runSeries([
          function writeToFile (done) {
            fs.writeFile(
              date,
              JSON.stringify(data, null, 2),
              done
            )
          },
          function sendEMail (done) {
            email(data, done)
          }
        ], function (error) {
          if (error) {
            response.statusCode = 500
            return response.end(`<p>Internal Error</p>`)
          }
        })
      })
  )
}

var FormData = require('form-data')
var https = require('https')
var simpleConcat = require('simple-concat')

function email (data, log) {
  var form = new FormData()
  form.append('from', FROM)
  form.append('to', TO)
  form.append('cc', data.cc)
  form.append('subject', 'Sales Referral')
  form.append('text', dataToMessage(data))
  var options = {
    method: 'POST',
    host: 'api.mailgun.net',
    path: '/v3/' + DOMAIN + '/messages',
    auth: 'api:' + MAILGUN_KEY,
    headers: form.getHeaders()
  }
  var request = https.request(options)
  request.once('response', function (response) {
    var status = response.statusCode
    if (status === 200) {
      log.info({ event: 'sent' })
      return
    }
    simpleConcat(response, function (_, buffer) {
      log.error({
        status: response.statusCode,
        body: buffer.toString()
      }, 'MailGun error')
    })
  })
  form.pipe(request)
}

function dataToMessage (data) {
  // TODO HTML e-mail
  return JSON.stringify(data, null, 2)
}

server.listen(process.env.PORT || 8080, function () {
  var port = this.address().port
  log.info({ port }, 'litening')
})
