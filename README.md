# sales.kemitchell.com

a one-page-one-form web application for attorney intake of new client sales transactions

## Configuration

The following environment variables configure the application:

- `CLIENTS`, optional, path to a JSON file containing an array of objects about how to handle submissions from specific clients

- `DATA`, optional, path for the directory in which to submissions and their attachments

- `DOMAIN`, the domain name on which the application will run

- `FROM`, the e-mail address from which to send e-mails

- `MAILGUN_KEY`, the [MailGun](https://mailgun.com) API key

- `PASSWORD`, the password clients will use to access the form

- `PORT`, the port the application will bind

- `TITLE`, the page title

- `TO`, the e-mail address for the lawyer who will receive submissions
