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
