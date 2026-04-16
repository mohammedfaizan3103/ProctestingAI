import express from "express";
import SibApiV3Sdk from "sib-api-v3-sdk";

const router = express.Router();

// POST /api/contact - public contact form
router.post("/contact", async (req, res) => {
  try {
    const { name, email, message } = req.body || {};
    if (!name || !email || !message) {
      return res
        .status(400)
        .json({ error: "Name, email and message are required" });
    }

    // Basic email sanity check
    const emailOk = /.+@.+\..+/.test(String(email));
    if (!emailOk)
      return res.status(400).json({ error: "Please provide a valid email" });

    const brevoApiKey = process.env.BREVO_API_KEY;
    if (!brevoApiKey) {
      return res
        .status(500)
        .json({ error: "Email service is not configured (BREVO_API_KEY)" });
    }

    // Configure Brevo client
    const defaultClient = SibApiV3Sdk.ApiClient.instance;
    const apiKey = defaultClient.authentications["api-key"];
    apiKey.apiKey = brevoApiKey;

    const smtpApi = new SibApiV3Sdk.TransactionalEmailsApi();
    const to =
      process.env.CONTACT_RECEIVER || "ashwithgodishala.work@gmail.com";
    const senderEmail =
      process.env.BREVO_SENDER_EMAIL ||
      process.env.SMTP_USER ||
      "no-reply@example.com";
    const senderName = process.env.BREVO_SENDER_NAME || "Contact Form";

    const html = `<p><strong>From:</strong> ${name} &lt;${email}&gt;</p><p>${String(
      message
    ).replace(/\n/g, "<br>")}</p>`;

    const payload = {
      sender: { email: senderEmail, name: senderName },
      to: [{ email: to }],
      replyTo: { email, name },
      subject: `New contact message from ${name}`,
      htmlContent: html,
      textContent: `From: ${name} <${email}>\n\n${message}`,
      headers: {
        "X-Entity-Ref-ID": `contact-${Date.now()}`,
      },
    };

    const info = await smtpApi.sendTransacEmail(payload);

    return res.status(200).json({ ok: true, id: info && info.messageId });
  } catch (err) {
    console.error("/contact error:", {
      message: err && err.message,
      code: err && err.code,
      status: err && err.status,
      response: err && err.response && err.response.text,
    });
    return res.status(500).json({ error: "Failed to send message" });
  }
});

export default router;
