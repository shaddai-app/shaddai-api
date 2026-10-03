export type MailLocale = 'es' | 'en' | 'pt';

export function resolveMailLocale(...candidates: (string | null | undefined)[]): MailLocale {
  const found = candidates.find((c) => c === 'es' || c === 'en' || c === 'pt');
  return (found as MailLocale | undefined) ?? 'es';
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function layout(title: string, paragraphs: string[], action: { label: string; url: string }) {
  const body = paragraphs.map((p) => `<p style="margin:0 0 16px">${escapeHtml(p)}</p>`).join('');
  return `<!doctype html><html><body style="font-family:system-ui,Segoe UI,Roboto,sans-serif;color:#1f2937;background:#f3f4f6;padding:24px">
<div style="max-width:520px;margin:auto;background:#fff;border-radius:12px;padding:32px">
<h1 style="font-size:20px;margin:0 0 16px;color:#3b5f94">${escapeHtml(title)}</h1>${body}
<p style="margin:24px 0"><a href="${escapeHtml(action.url)}" style="background:#3b5f94;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;display:inline-block">${escapeHtml(action.label)}</a></p>
<p style="font-size:12px;color:#6b7280;word-break:break-all">${escapeHtml(action.url)}</p>
</div></body></html>`;
}

const passwordResetCopy = {
  es: {
    subject: 'Restablecé tu contraseña de Shaddai',
    hello: (name: string) => `Hola ${name}:`,
    body: 'Recibimos un pedido para restablecer tu contraseña. El enlace vence en 30 minutos y se puede usar una sola vez.',
    ignore: 'Si no fuiste vos, ignorá este mensaje: tu contraseña no cambia.',
    action: 'Crear nueva contraseña',
  },
  en: {
    subject: 'Reset your Shaddai password',
    hello: (name: string) => `Hi ${name},`,
    body: 'We received a request to reset your password. The link expires in 30 minutes and can be used only once.',
    ignore: "If this wasn't you, ignore this message: your password won't change.",
    action: 'Create new password',
  },
  pt: {
    subject: 'Redefina sua senha do Shaddai',
    hello: (name: string) => `Olá ${name},`,
    body: 'Recebemos um pedido para redefinir sua senha. O link expira em 30 minutos e pode ser usado uma única vez.',
    ignore: 'Se não foi você, ignore esta mensagem: sua senha não será alterada.',
    action: 'Criar nova senha',
  },
} as const;

const accessCopy = {
  es: {
    subject: (church: string) => `Tu acceso a Shaddai — ${church}`,
    hello: (name: string) => `Hola ${name}:`,
    body: (church: string) => `Ya tenés acceso a Shaddai en ${church}.`,
    password: (pass: string) => `Contraseña temporal: ${pass}`,
    note: 'Es de un solo uso: al ingresar te vamos a pedir que crees tu propia contraseña.',
    action: 'Ingresar',
  },
  en: {
    subject: (church: string) => `Your Shaddai access — ${church}`,
    hello: (name: string) => `Hi ${name},`,
    body: (church: string) => `You now have access to Shaddai at ${church}.`,
    password: (pass: string) => `Temporary password: ${pass}`,
    note: "It's single-use: when you sign in you'll be asked to create your own password.",
    action: 'Sign in',
  },
  pt: {
    subject: (church: string) => `Seu acesso ao Shaddai — ${church}`,
    hello: (name: string) => `Olá ${name},`,
    body: (church: string) => `Você já tem acesso ao Shaddai em ${church}.`,
    password: (pass: string) => `Senha temporária: ${pass}`,
    note: 'É de uso único: ao entrar, pediremos que você crie sua própria senha.',
    action: 'Entrar',
  },
} as const;

/** Acceso inicial o reset por un administrador: contraseña temporal con cambio obligatorio. */
export function temporaryAccessMail(
  locale: MailLocale,
  data: { name: string; church: string; password: string; url: string },
) {
  const c = accessCopy[locale];
  const paragraphs = [c.hello(data.name), c.body(data.church), c.password(data.password), c.note];
  const subject = c.subject(data.church);
  return {
    subject,
    text: [...paragraphs, '', `${c.action}: ${data.url}`].join('\n'),
    html: layout(subject, paragraphs, { label: c.action, url: data.url }),
  };
}

export function passwordResetMail(locale: MailLocale, name: string, url: string) {
  const c = passwordResetCopy[locale];
  const paragraphs = [c.hello(name), c.body, c.ignore];
  return {
    subject: c.subject,
    text: [...paragraphs, '', `${c.action}: ${url}`].join('\n'),
    html: layout(c.subject, paragraphs, { label: c.action, url }),
  };
}

/** Mail con título, párrafos y un botón (avisos del centro de notificaciones). */
export function actionMail(subject: string, paragraphs: string[], action: { label: string; url: string }) {
  return {
    subject,
    text: [...paragraphs, '', `${action.label}: ${action.url}`].join('\n'),
    html: layout(subject, paragraphs, action),
  };
}

const closureCopy = {
  es: {
    subject: (church: string) => `Baja de ${church} en Shaddai`,
    hello: (name: string) => `Hola ${name}:`,
    body: (church: string, date: string) =>
      `Recibimos el pedido de baja de ${church}. Desde ahora nadie de la iglesia puede entrar y el ${date} se borran definitivamente todos sus datos y archivos.`,
    undo: 'Si fue un error o necesitás recuperar algo antes de esa fecha, escribinos y la reactivamos.',
    action: 'Escribir a soporte',
  },
  en: {
    subject: (church: string) => `${church} closed on Shaddai`,
    hello: (name: string) => `Hi ${name},`,
    body: (church: string, date: string) =>
      `We received the request to close ${church}. From now on nobody from the church can sign in, and on ${date} all its data and files will be permanently deleted.`,
    undo: 'If this was a mistake or you need to recover something before that date, write to us and we will reactivate it.',
    action: 'Contact support',
  },
  pt: {
    subject: (church: string) => `Encerramento de ${church} no Shaddai`,
    hello: (name: string) => `Olá ${name},`,
    body: (church: string, date: string) =>
      `Recebemos o pedido de encerramento de ${church}. A partir de agora ninguém da igreja pode entrar e em ${date} todos os seus dados e arquivos serão apagados definitivamente.`,
    undo: 'Se foi um engano ou você precisa recuperar algo antes dessa data, escreva para nós e a reativamos.',
    action: 'Falar com o suporte',
  },
} as const;

/** Confirmación de la baja de una cuenta, con la fecha de borrado definitivo. */
export function accountClosureMail(
  locale: MailLocale,
  data: { name: string; church: string; purgeAfter: Date; timezone: string; supportEmail: string },
) {
  const c = closureCopy[locale];
  const date = new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeZone: data.timezone }).format(
    data.purgeAfter,
  );
  const paragraphs = [c.hello(data.name), c.body(data.church, date), c.undo];
  const subject = c.subject(data.church);
  const action = { label: c.action, url: `mailto:${data.supportEmail}` };
  return {
    subject,
    text: [...paragraphs, '', `${c.action}: ${data.supportEmail}`].join('\n'),
    html: layout(subject, paragraphs, action),
  };
}

export type SecurityEvent = 'totp_disabled' | 'totp_reset' | 'recovery_code_used';

const securityCopy = {
  es: {
    subject: 'Cambio en la seguridad de tu cuenta de Shaddai',
    hello: (name: string) => `Hola ${name}:`,
    events: {
      totp_disabled: 'Se desactivó la verificación en dos pasos de tu cuenta.',
      totp_reset:
        'Un administrador de tu iglesia restableció tu verificación en dos pasos: la próxima vez entrás solo con la contraseña y podés volver a activarla.',
      recovery_code_used: (left: number) =>
        `Se entró a tu cuenta con un código de recuperación. Te quedan ${left}; si se te terminan, generá nuevos desde Seguridad.`,
    },
    notYou: 'Si no fuiste vos, cambiá tu contraseña ahora y avisale al administrador de tu iglesia.',
    action: 'Revisar seguridad',
  },
  en: {
    subject: 'A security change on your Shaddai account',
    hello: (name: string) => `Hi ${name},`,
    events: {
      totp_disabled: 'Two-step verification was turned off on your account.',
      totp_reset:
        'An administrator of your church reset your two-step verification: next time you sign in with your password only, and you can turn it on again.',
      recovery_code_used: (left: number) =>
        `Someone signed in to your account with a recovery code. You have ${left} left; if you run out, generate new ones from Security.`,
    },
    notYou: "If this wasn't you, change your password now and tell your church administrator.",
    action: 'Review security',
  },
  pt: {
    subject: 'Mudança na segurança da sua conta do Shaddai',
    hello: (name: string) => `Olá ${name},`,
    events: {
      totp_disabled: 'A verificação em duas etapas da sua conta foi desativada.',
      totp_reset:
        'Um administrador da sua igreja redefiniu sua verificação em duas etapas: da próxima vez você entra só com a senha e pode ativá-la de novo.',
      recovery_code_used: (left: number) =>
        `Alguém entrou na sua conta com um código de recuperação. Restam ${left}; se acabarem, gere novos em Segurança.`,
    },
    notYou: 'Se não foi você, troque sua senha agora e avise o administrador da sua igreja.',
    action: 'Revisar segurança',
  },
} as const;

/** Aviso al usuario de un cambio en su verificación en dos pasos. */
export function securityAlertMail(
  locale: MailLocale,
  data: { name: string; event: SecurityEvent; recoveryCodesLeft?: number; url: string },
) {
  const c = securityCopy[locale];
  const event =
    data.event === 'recovery_code_used'
      ? c.events.recovery_code_used(data.recoveryCodesLeft ?? 0)
      : c.events[data.event];
  const paragraphs = [c.hello(data.name), event, c.notYou];
  return {
    subject: c.subject,
    text: [...paragraphs, '', `${c.action}: ${data.url}`].join('\n'),
    html: layout(c.subject, paragraphs, { label: c.action, url: data.url }),
  };
}
