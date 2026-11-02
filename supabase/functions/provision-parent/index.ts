import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function canonicalPhone(value: string) {
  let digits = String(value ?? "").replace(/\D/g, "");
  if (digits.startsWith("00213")) digits = digits.slice(5);
  else if (digits.startsWith("213")) digits = digits.slice(3);
  digits = digits.replace(/^0+/, "");
  return /^\d{9}$/.test(digits) ? `0${digits}` : String(value ?? "").trim();
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const accessToken = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!accessToken) return json({ error: "Authentication required" }, 401);

  const admin = (path: string, options: RequestInit = {}) => fetch(`${supabaseUrl}${path}`, {
    ...options,
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
      ...(options.headers ?? {}),
    },
  });

  const userRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { apikey: serviceRoleKey, Authorization: `Bearer ${accessToken}` },
  });
  if (!userRes.ok) return json({ error: "Invalid session" }, 401);
  const user = await userRes.json();

  const profileRes = await admin(`/rest/v1/profiles?id=eq.${user.id}&select=id,school_id,role`);
  const profiles = await profileRes.json();
  const profile = profiles?.[0];
  if (!profile || profile.role !== "director") return json({ error: "Director access only" }, 403);

  let body: { phone?: string; displayName?: string; reset?: boolean };
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
  const phone = canonicalPhone(body.phone ?? "");
  const displayName = String(body.displayName ?? "").trim();
  const reset = body.reset !== false;
  if (!/^0\d{9}$/.test(phone)) return json({ error: "Invalid phone number" }, 400);
  if (!displayName) return json({ error: "Parent name required" }, 400);

  const pin = String(Math.floor(100000 + Math.random() * 900000));
  const email = `${phone}@eduvia.local`;
  let authUserId: string | null = null;

  const createRes = await admin("/auth/v1/admin/users", {
    method: "POST",
    body: JSON.stringify({ email, password: pin, email_confirm: true, user_metadata: { role: "parent", name: displayName } }),
  });

  if (createRes.ok) {
    authUserId = (await createRes.json()).id;
  } else {
    const status = createRes.status;
    if (status !== 422 && status !== 409) return json({ error: await createRes.text() }, 400);
    const listRes = await admin("/auth/v1/admin/users?page=1&per_page=1000");
    if (!listRes.ok) return json({ error: "Unable to find existing account" }, 500);
    const users = (await listRes.json()).users ?? [];
    const found = users.find((u: any) => u.email === email);
    if (!found) return json({ error: "Account exists but could not be resolved" }, 409);
    authUserId = found.id;
    if (reset) {
      const resetRes = await admin(`/auth/v1/admin/users/${found.id}`, {
        method: "PUT",
        body: JSON.stringify({ password: pin }),
      });
      if (!resetRes.ok) return json({ error: await resetRes.text() }, 500);
    } else {
      return json({ error: "Account already exists. Request a reset explicitly." }, 409);
    }
  }

  if (!authUserId) return json({ error: "Account creation failed" }, 500);

  await admin("/rest/v1/profiles?on_conflict=id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ id: authUserId, school_id: profile.school_id, role: "parent", display_name: displayName, login_id: phone }),
  });

  const studentsRes = await admin(`/rest/v1/students?select=id,full_name,class_label,parent_phone&school_id=eq.${profile.school_id}`);
  if (studentsRes.ok) {
    const students = await studentsRes.json();
    for (const student of students.filter((s: any) => canonicalPhone(s.parent_phone) === phone)) {
      await admin("/rest/v1/guardians?on_conflict=profile_id,student_id", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({ profile_id: authUserId, student_id: student.id, relation: "parent" }),
      });
    }
  }

  await admin("/rest/v1/parent_credential_issuances", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ school_id: profile.school_id, profile_id: authUserId, login_id: phone, display_name: displayName, action: reset ? "reset" : "issued", issued_by: user.id }),
  });

  return json({ phone, pin, loginId: phone, displayName });
});
