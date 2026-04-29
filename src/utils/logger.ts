import pino from 'pino';

let _logger: pino.Logger | null = null;

const isTest = process.env['NODE_ENV'] === 'test';

export function createLogger(level = 'info'): pino.Logger {
  // In test/silent mode avoid spawning pino-pretty worker threads
  if (isTest || level === 'silent') {
    _logger = pino({ level: 'silent' });
    return _logger;
  }

  _logger = pino({
    level,
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:HH:MM:ss.l',
        ignore: 'pid,hostname',
        messageFormat: '{msg}',
        singleLine: false,
      },
    },
  });
  return _logger;
}

export function getLogger(): pino.Logger {
  if (!_logger) _logger = createLogger();
  return _logger;
}
