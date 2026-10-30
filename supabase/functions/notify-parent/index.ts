import { createClient } from "npm:@supabase/supabase-js@2";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const whatsappToken = Deno.env.get("WHATSAPP_ACCESS_TOKEN")!;
const whatsappPhoneId = Deno.env.get("WHATSAPP_PHONE_NUMBER_ID")!;
const whatsappTemplate = Deno.env.get("WHATSAPP_TEMPLATE_NAME") || "eduvia_gate_alert";

Deno.serve(async () => {
  if (!whatsappToken || !whatsappPhoneId) {
    return new Response(JSON.stringify({ error: "WhatsApp secrets are not configured" }), {
      status: 503, headers: { "content-type": "application/json" }
    });
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey);
  const { data: jobs, error } = await supabase
    .from("outbox")
    .select("*")
    .eq("channel", "whatsapp")
    .eq("status", "queued")
    .limit(25);

  if (error) throw error;
  let sent = 0, failed = 0;

  for (const job of jobs || []) {
    if (!job.phone) {
      await supabase.from("outbox").update({ status: "failed" }).eq("id", job.id);
      failed++;
      continue;
    }

    const phone = String(job.phone).replace(/[^0-9]/g, "");
    const payload = {
      messaging_product: "whatsapp",
      to: phone,
      type: "template",
      template: {
        name: whatsappTemplate,
        language: { code: "ar" },
        components: [{ type: "body", parameters: [{ type: "text", text: job.body }] }]
      }
    };

    const response = await fetch(`https://graph.facebook.com/v22.0/${whatsappPhoneId}/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${whatsappToken}`, "content-type": "application/json" },
      body: JSON.stringify(payload)
    });

    if (response.ok) {
      await supabase.from("outbox").update({ status: "sent", sent_at: new Date().toISOString() }).eq("id", job.id);
      sent++;
    } else {
      const detail = await response.text();
      await supabase.from("outbox").update({ status: "failed", error: detail.slice(0, 1000) }).eq("id", job.id);
      failed++;
    }
  }

  return new Response(JSON.stringify({ sent, failed }), {
    headers: { "content-type": "application/json" }
  });
});
