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

var TITLE = process.env.TITLE || 'Sales Intake Form'

var path = require('path')
var DATA = process.env.DATA || 'sales'
var CLIENTS = process.env.CLIENTS || path.join(DATA, 'clients.json')

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
var escapeHTML = require('escape-html')

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
              input = `<select name=${name} required>${options(question)}</select>`
            } else {
              input = `<textarea name=${name} required></textarea>`
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
    <title>${escapeHTML(TITLE)}</title>
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

fieldset {
  margin: 1rem 0;
}
    </style>
  </head>

  <body>
    <header role=banner>
      <h1>${escapeHTML(TITLE)}</h1>
    </header>

    <main role=main>
      <form
          action=/?password=${PASSWORD}
          method=post
          enctype=multipart/form-data>
        ${fields}
        <fieldset>
          <legend>Files</legend>
          <input name=files[] type=file multiple>
        </fieldset>
        <fieldset>
          <legend>Submit</legend>
          <label for=cc>Your E-Mail</label>
          <input name=cc type=email required>
          <p>You will be carbon copied on a summary of this form.</p>
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
var mkdirp = require('mkdirp')
var pump = require('pump')
var runSeries = require('run-series')
var uuid = require('uuid')

function post (request, response) {
  var password = request.query.password
  if (!password) {
    response.statusCode = 401
    return response.end()
  }
  if (password !== PASSWORD) {
    response.statusCode = 403
    return response.end()
  }
  var id = uuid.v4()
  var directory = path.join(DATA, id)
  var attachments = path.join(directory, 'attachments')
  var data = {
    date: new Date().toISOString(),
    files: [],
    directory
  }
  var whitelist = ['cc']
  questionnaire.forEach(function (section) {
    return section.questions.some(function (question) {
      whitelist.push(question.name)
    })
  })
  request.pipe(
    new Busboy({ headers: request.headers })
      .on('field', function (name, value) {
        if (whitelist.includes(name)) data[name] = value.trim()
      })
      .on('file', function (field, stream, name, encoding, mime) {
        mkdirp(attachments, function (error) {
          if (error) return request.log.error(error)
          var file = path.join(attachments, name)
          pump(
            stream,
            fs.createWriteStream(file),
            function (error) {
              if (error) return request.log.error(error)
              data.files.push(file)
            }
          )
        })
      })
      .on('finish', function () {
        runSeries([
          function makeDirectory (done) {
            mkdirp(directory, done)
          },
          function writeDataFile (done) {
            var files = data.files.map(function (entry) {
              return { name: entry.name, mime: entry.mime }
            })
            var object = { data, questionnaire, files }
            fs.writeFile(
              path.join(directory, `data.json`),
              JSON.stringify(object, null, 2),
              done
            )
          },
          function loadClientData (done) {
            readClientData(data.cc, function (error, client) {
              if (error) return done(error)
              data.client = client
              done()
            })
          },
          function sendEMail (done) {
            email(data, request.log, done)
          }
        ], function (error) {
          if (error) {
            request.log.error(error)
            response.statusCode = 500
            return response.end(`<p>Internal Error</p>`)
          }
          response.end('<p>Success! You should receive an e-mail shortly.</p>')
        })
      })
  )
}

var FormData = require('form-data')
var https = require('https')
var simpleConcat = require('simple-concat')

function email (data, log, callback) {
  var form = new FormData()
  form.append('from', FROM)
  form.append('to', TO)
  var cc = [data.cc.toLowerCase()]
  form.append('subject', 'Sales Intake: ' + data.lead)
  var markdown = dataToMarkdown(data)
  form.append('text', markdown)
  form.append('html', renderMarkdown(markdown))
  data.files.forEach(function (file) {
    form.append('attachment', fs.createReadStream(file))
  })
  var client = data.client
  if (client) {
    var address = client.cc.toLowerCase()
    if (!cc.includes(address)) cc.push(address)
  }
  form.append('cc', cc.join(', '))
  form.append('h:Reply-To', data.cc)
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
      return callback()
    }
    simpleConcat(response, function (_, buffer) {
      var message = buffer.toString()
      log.error({
        status: response.statusCode,
        body: message
      }, 'MailGun error')
      callback(new Error('MailGun:' + message))
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
  var reader = new commonmark.Parser({ smart: true })
  var writer = new commonmark.HtmlRenderer()
  var parsed = reader.parse(markdown)
  return writer.render(parsed)
}

var has = require('has')

function readClientData (email, callback) {
  fs.readFile(CLIENTS, function (error, buffer) {
    if (error) {
      if (error.code === 'ENOENT') return callback(null, false)
      return callback(error)
    }
    try {
      var parsed = JSON.parse(buffer)
    } catch (error) {
      return callback(error)
    }
    if (Array.isArray(parsed)) return callback(null, false)
    var client = parsed.find(function (client) {
      var matchesEMail = (
        has(client, 'emails') &&
        client.emails.includes(email)
      )
      if (matchesEMail) return true
      var domain = email.split('@')[1].toLowerCase()
      var matchesDomain = (
        has(client, 'domain') &&
        client.domain.toLowerCase() === domain
      )
      if (matchesDomain) return true
      return false
    }) || false
    callback(null, client)
  })
}
