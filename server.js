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

var DATA = process.env.DATA || 'sales'

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

var questionnaire = require('./questionnaire')

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
  var fields = questionnaire
    .map(function (section) {
      return `<fieldset><legend>${section.heading}</legend>${inputs()}</fieldset>`
      function inputs () {
        return section.questions
          .map(function (question) {
            var name = question.name
            var prompt = question.prompt
            var label = `<label for=${name}>${prompt}</label>`
            var input
            if (question.options) {
              input = `<select name=${name}>${options(question)}</select>`
            } else {
              input = `<textarea name=${name}></textarea>`
            }
            return label + input
          })
          .join('')
      }

      function options (question) {
        var options = question.options
        return Object.keys(question.options)
          .map(function (value) {
            return `<option value=${value}>${options[value]}</option>`
          })
          .join('')
      }
    })
    .join('')
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
        ${fields}
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

var Busboy = require('busboy')
var fs = require('fs')
var runSeries = require('run-series')
var path = require('path')
var uuid = require('uuid')

function post (request, response) {
  var id = uuid.v4()
  var data = { date: new Date().toISOString() }
  request.pipe(
    new Busboy({ headers: request.headers })
      .on('field', function (name, value) {
        var expected = questionnaire.some(function (section) {
          return section.questions.some(function (question) {
            return question.name === name
          })
        })
        if (expected) data[name] = value.trim()
      })
      .on('finish', function () {
        runSeries([
          function writeToFile (done) {
            fs.writeFile(
              path.join(DATA, `${id}.json`),
              JSON.stringify({ data, questionnaire }, null, 2),
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
  form.append('subject', 'Sales Intake')
  var markdown = dataToMarkdown(data)
  form.append('text', markdown)
  form.append('html', renderMarkdown(markdown))
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

function dataToMarkdown (data) {
  return questionnaire
    .map(function (section) {
      var heading = `## ${section.heading}\n\n`
      var answers = section.questions
        .map(function (question) {
          var name = question.name
          var answer = data[name]
          return `${question.prompt}\n\n> ${answer}`
        })
        .join('\n\n')
      return heading + answers
    })
    .join('\n\n') + '\n'
}

server.listen(process.env.PORT || 8080, function () {
  var port = this.address().port
  log.info({ port }, 'litening')
})

var commonmark = require('commonmark')

function renderMarkdown (markdown) {
  var reader = new commonmark.Parser()
  var writer = new commonmark.HtmlRenderer()
  var parsed = reader.parse(markdown)
  return writer.render(parsed)
}
