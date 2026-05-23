const DEFAULT_CONFIG = {
  from: "51视频最新地址 <get@51cmtv.com>",
  subject: "51视频最新地址",
  text: "最新地址 🍉🍉🍉 (本信息更新时间 2026-05-20)\n\n\n\n51视频最新官网 https://51cmtv.com  请把网址或者群分享给身边有需要的人，您的转发、分享是我们前进的动力😘～"
};

function fallbackConfig(env) {
  return {
    from: env.REPLY_FROM || DEFAULT_CONFIG.from,
    subject: env.REPLY_SUBJECT || DEFAULT_CONFIG.subject,
    text: env.REPLY_TEXT || DEFAULT_CONFIG.text
  };
}

function isAutoResponder(address) {
  return /mailer-daemon|postmaster|no-?reply|do-?not-?reply/i.test(address || "");
}

async function loadConfig(env) {
  const fallback = fallbackConfig(env);
  if (!env.CONFIG_URL) return fallback;

  try {
    const response = await fetch(env.CONFIG_URL, {
      headers: { accept: "application/json" },
      cf: { cacheTtl: 0, cacheEverything: false }
    });
    if (!response.ok) return fallback;

    const data = await response.json();
    return {
      from: String(data.from || fallback.from),
      subject: String(data.subject || fallback.subject),
      text: String(data.text || fallback.text)
    };
  } catch (_error) {
    return fallback;
  }
}

async function sendWithResend(env, payload) {
  if (!env.RESEND_API_KEY) {
    throw new Error("Missing RESEND_API_KEY");
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.RESEND_API_KEY}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error(`Resend failed: ${response.status} ${await response.text()}`);
  }
}

export default {
  async email(message, env, ctx) {
    const recipient = message.from;
    if (!recipient || isAutoResponder(recipient)) return;

    const config = await loadConfig(env);
    const payload = {
      from: config.from,
      to: recipient,
      subject: config.subject,
      text: config.text
    };

    ctx.waitUntil(sendWithResend(env, payload));

    if (env.FORWARD_TO) {
      await message.forward(env.FORWARD_TO);
    }
  }
};
