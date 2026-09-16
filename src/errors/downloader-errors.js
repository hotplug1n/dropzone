// Error hierarchy for the downloader. Every error carries a machine-readable
// `code`, a `friendlyMessage` safe to show to end users (no stack traces,
// no internal paths), optional `context` for diagnostics, and the original
// `cause` when one exists, so nothing fails silently.

export class DownloaderError extends Error {
  constructor(message, { code, friendlyMessage, context, cause } = {}) {
    super(message);
    this.name = this.constructor.name;
    this.code = code || 'DOWNLOADER_ERROR';
    this.friendlyMessage = friendlyMessage || 'Não foi possível concluir o download.';
    this.context = context || {};
    if (cause) this.cause = cause;
  }

  toJSON() {
    return {
      code: this.code,
      message: this.friendlyMessage,
      context: this.context,
    };
  }
}

export class InvalidUrlError extends DownloaderError {
  constructor(message, opts = {}) {
    super(message, { code: 'INVALID_URL', friendlyMessage: 'A URL informada não é válida.', ...opts });
  }
}

export class UnsupportedUrlError extends DownloaderError {
  constructor(message, opts = {}) {
    super(message, { code: 'UNSUPPORTED_URL', friendlyMessage: 'Este domínio ou tipo de link não é suportado.', ...opts });
  }
}

export class InvalidOptionsError extends DownloaderError {
  constructor(message, opts = {}) {
    super(message, { code: 'INVALID_OPTIONS', friendlyMessage: 'A combinação de formato, qualidade ou bitrate selecionada não é suportada.', ...opts });
  }
}

export class ApiError extends DownloaderError {
  constructor(message, opts = {}) {
    super(message, { code: 'API_ERROR', friendlyMessage: 'O serviço de download retornou um erro inesperado.', ...opts });
  }
}

export class AuthenticationError extends DownloaderError {
  constructor(message, opts = {}) {
    super(message, { code: 'AUTHENTICATION_ERROR', friendlyMessage: 'Falha de autenticação com o serviço de download.', ...opts });
  }
}

export class RateLimitError extends DownloaderError {
  constructor(message, opts = {}) {
    super(message, { code: 'RATE_LIMIT', friendlyMessage: 'Muitas solicitações em pouco tempo. Tente novamente em instantes.', ...opts });
  }
}

export class MediaUnavailableError extends DownloaderError {
  constructor(message, opts = {}) {
    super(message, { code: 'MEDIA_UNAVAILABLE', friendlyMessage: 'O vídeo não está disponível para download (privado, removido, restrito por idade/região ou ao vivo).', ...opts });
  }
}

export class ProcessingError extends DownloaderError {
  constructor(message, opts = {}) {
    super(message, { code: 'PROCESSING_ERROR', friendlyMessage: 'Ocorreu um erro ao processar o arquivo de mídia.', ...opts });
  }
}

export class DownloadError extends DownloaderError {
  constructor(message, opts = {}) {
    super(message, { code: 'DOWNLOAD_ERROR', friendlyMessage: 'Falha ao transferir o arquivo.', ...opts });
  }
}

export class FileSystemError extends DownloaderError {
  constructor(message, opts = {}) {
    super(message, { code: 'FILESYSTEM_ERROR', friendlyMessage: 'Erro ao salvar o arquivo no disco.', ...opts });
  }
}

export class TimeoutError extends DownloaderError {
  constructor(message, opts = {}) {
    super(message, { code: 'TIMEOUT', friendlyMessage: 'A operação demorou demais e foi cancelada.', ...opts });
  }
}

export class ConfigurationError extends DownloaderError {
  constructor(message, opts = {}) {
    super(message, { code: 'CONFIGURATION_ERROR', friendlyMessage: 'O servidor não está configurado corretamente.', ...opts });
  }
}

export class SecurityError extends DownloaderError {
  constructor(message, opts = {}) {
    super(message, { code: 'SECURITY_ERROR', friendlyMessage: 'A solicitação foi bloqueada por motivos de segurança.', ...opts });
  }
}
