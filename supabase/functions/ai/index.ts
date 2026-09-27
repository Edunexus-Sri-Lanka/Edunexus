// EduNexus AI service.
// Runs on Supabase Edge Functions. The Groq key lives here, never in the browser.
// Deploy:  supabase functions deploy ai
// Secret:  supabase secrets set GROQ_API_KEY=your_key

import { createClient } from "jsr:@supabase/supabase-js@2";

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const MODEL = "openai/gpt-oss-120b";
const MODEL_VISION = "qwen/qwen3.8-27b"; // the only vision-capable model Groq currently hosts

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

async function groq(messages: unknown[], jsonMode = false, model = MODEL, maxTokens = 1200) {
  const key = Deno.env.get("GROQ_API_KEY");
  if (!key) throw new Error("GROQ_API_KEY is not set on the function");
  const res = await fetch(GROQ_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.3,
      max_tokens: maxTokens,
      ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
    }),
  });
  if (!res.ok) throw new Error(`Model error ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? "";
}
const asJson = (text: string) => {
  const clean = text.replace(/```json|```/g, "").trim();
  try { return JSON.parse(clean); }
  catch { const m = clean.match(/[{[][\s\S]*[}\]]/); if (m) return JSON.parse(m[0]); throw new Error("Model did not return JSON"); }
};

/* Build a compact picture of the student from their own rows. */
function genomeSummary(attempts: any[]) {
  const W: Record<string, number> = { test: 30, paper: 22, examlens: 18, mirage: 18, quiz: 14, doctor: 10, lesson: 6 };
  const now = Date.now(), byTopic: Record<string, { num: number; den: number; n: number; subject: string }> = {};
  for (const a of attempts) {
    const w = W[a.kind] ?? 10;
    const days = (now - new Date(a.created_at).getTime()) / 86400000;
    const decay = Math.pow(0.5, days / 60);
    const t = (byTopic[a.topic] ||= { num: 0, den: 0, n: 0, subject: a.subject || "" });
    t.num += Number(a.score) * w * decay; t.den += w * decay; t.n++;
  }
  return Object.entries(byTopic)
    .map(([topic, v]) => ({ topic, subject: v.subject, score: Math.round(v.num / v.den), evidence: v.n }))
    .sort((a, b) => a.score - b.score);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return json({ error: "Sign in first" }, 401);

    const { task, payload = {} } = await req.json();

    /* ---- context the student's own rows provide -------------------- */
    let profile: any = null, topics: any[] = [], recent: any[] = [];
    if (["chat", "doctor", "advisor"].includes(task)) {
      const { data: p } = await sb.from("profiles").select("full_name, role, grade, goal, interests").eq("id", user.id).single();
      profile = p;
      const { data: att } = await sb.from("attempts")
        .select("kind, subject, topic, score, seconds, meta, created_at")
        .eq("student_id", user.id).order("created_at", { ascending: false }).limit(120);
      recent = att ?? [];
      topics = genomeSummary(recent);
    }

    // The app has no math-rendering library, so raw LaTeX (\( \), \frac, $$) shows as
    // broken escaped text — every task that might touch numbers or formulas needs this.
    const noMath = " Write any math in plain text only, e.g. v0 sin(theta), x^2, (1/2) g t^2 — never LaTeX, never \\( \\), \\frac{}{}, or $ delimiters.";
    const rules =
      "You are Edu AI inside EduNexus, a school platform. Speak to the student directly, warmly and plainly. " +
      "Use ONLY the evidence given to you. Never invent a score, a paper or a topic. " +
      "If the evidence is thin, say so and tell them what to complete so you can help properly. " +
      "Two or three short paragraphs at most. No bullet lists unless asked." + noMath;

    let out: any;
    switch (task) {
      case "chat": {
        const ctx = topics.length
          ? topics.map(t => `${t.topic} (${t.subject || "—"}): ${t.score}% from ${t.evidence} pieces of evidence`).join("\n")
          : "No graded work recorded yet.";
        const last = recent.slice(0, 8).map(a => `${a.kind} on ${a.topic}: ${a.score}%`).join("; ") || "none";
        const isFirstTurn = !(payload.history ?? []).length;

        /* Durable notes that survive across every thread, not just this one —
           the same mechanism the teacher assistant already uses. */
        const { data: memory }: any = await sb.from("student_memory").select("id, note, source, created_at")
          .eq("student_id", user.id).order("created_at", { ascending: true }).limit(60);

        const messages = [
          { role: "system", content: `${rules}\n\nStudent: ${profile?.full_name}. Class: ${profile?.grade ?? "unknown"}. Stated goal: ${profile?.goal ?? "none given"}.\nTopic scores (weakest first):\n${ctx}\nMost recent work: ${last}\n\n` +
            `WHAT YOU REMEMBER ABOUT THIS STUDENT ACROSS EVERY CONVERSATION:\n` +
            ((memory ?? []).map((m: any) => `[${m.id}] ${m.note}`).join("\n") || "nothing yet") +
            `\n\nMEMORY. Save a note only for things that will still matter in a later, different conversation: their goals, ` +
            `preferences, plans, or context they've told you that isn't already in the data above. Never save grades or ` +
            `scores, those are live data. At most 2 new notes per reply, each one short sentence. If they ask you to ` +
            `remember something, save it. If they ask you to forget something, or a note is now wrong, list its id in ` +
            `forget. Do not repeat notes you already have.\n\nReturn JSON only: {"reply":string,"remember":[string],"forget":[string]}.\n\n` +
            (isFirstTurn
              ? `This is the first message of the conversation — a natural "Hi ${profile?.full_name?.split(" ")[0] || "there"}" is fine here.`
              : `This conversation is already underway — you can see the earlier turns below. Do not open with their name or a greeting again; reply like someone mid-conversation, not someone meeting them for the first time. Only use their name again if it's genuinely natural, not as a habit.`) },
          ...(payload.history ?? []).slice(-6),
          { role: "user", content: String(payload.message ?? "") },
        ];

        const res = asJson(await groq(messages, true, MODEL, 1800));
        const reply = String(res.reply ?? "").trim() || "Sorry, I couldn't put an answer together. Try asking again.";
        const known = new Set((memory ?? []).map((m: any) => m.note.toLowerCase()));
        const remember = (Array.isArray(res.remember) ? res.remember : []).map((n: any) => String(n).trim().slice(0, 400))
          .filter((n: string) => n && !known.has(n.toLowerCase())).slice(0, 2);
        const ids = new Set((memory ?? []).map((m: any) => m.id));
        const forget = (Array.isArray(res.forget) ? res.forget : []).map(String).filter((id: string) => ids.has(id));

        if (remember.length) await sb.from("student_memory").insert(remember.map((note: string) => ({ student_id: user.id, note, source: "assistant" })));
        if (forget.length) await sb.from("student_memory").delete().in("id", forget).eq("student_id", user.id);
        const { data: memNow }: any = await sb.from("student_memory").select("id, note, source, created_at")
          .eq("student_id", user.id).order("created_at", { ascending: true });

        out = { reply, topics: topics.slice(0, 4), evidenceCount: recent.length, remembered: remember, memory: memNow ?? [] };
        break;
      }
      case "title_chat": {
        const messages = [
          { role: "system", content: "Write a short title for a chat conversation, 3 to 6 words, based on the student's first message. No quotes, no trailing punctuation, no emoji. Return JSON only: {\"title\":string}." },
          { role: "user", content: String(payload.message ?? "").slice(0, 1000) },
        ];
        out = asJson(await groq(messages, true, MODEL, 500));
        break;
      }
      case "checkpoint": {
        const messages = [
          { role: "system", content: `${rules} The student just answered a lesson checkpoint. In two or three sentences, say why their answer works or where the thinking went wrong, and name the underlying idea.` },
          { role: "user", content: `Topic: ${payload.topic}\nQuestion: ${payload.question}\nOptions: ${(payload.options ?? []).join(" | ")}\nThey chose: ${payload.chosen}\nCorrect answer: ${payload.correct}\nWere they right: ${payload.wasRight}` },
        ];
        out = { text: await groq(messages) };
        break;
      }
      case "generate_checkpoint": {
        const messages = [
          { role: "system", content: "You write one multiple-choice checkpoint for a school lesson. Return JSON only: {\"question\":string,\"options\":[string,string,string],\"answer\":0,\"explanation\":string}. The wrong options must be plausible misconceptions, not obviously silly. answer is the index of the correct option." + noMath },
          { role: "user", content: `Subject: ${payload.subject}\nLesson: ${payload.title}\nTopic: ${payload.topic}\nLesson text: ${(payload.body ?? "").slice(0, 3000)}` },
        ];
        out = asJson(await groq(messages, true));
        break;
      }
      case "generate_lesson": {
        const messages = [
          { role: "system", content: "You write clear lesson notes for A-level students. Plain prose and short paragraphs, 200 to 300 words, no headings, no markdown symbols. Include the key relationship or definition stated precisely." + noMath },
          { role: "user", content: `Subject: ${payload.subject}\nLesson title: ${payload.title}\nTopic: ${payload.topic}` },
        ];
        out = { body: await groq(messages) };
        break;
      }
      case "summarise_video": {
        const transcript = String(payload.transcript ?? "").slice(0, 12000);
        const messages = [
          { role: "system", content: "You turn a lesson video's transcript into teaching material. Return JSON only: {\"summary\":string,\"notes\":string,\"key_points\":[string,string,string],\"checkpoint\":{\"question\":string,\"options\":[string,string,string],\"answer\":0,\"explanation\":string}}. summary is one or two sentences shown to students before they watch. notes is 150 to 250 words of plain-prose lesson notes, no headings. key_points is 3 to 5 short phrases. checkpoint follows the same rules as any other lesson checkpoint: plausible wrong options, not obviously silly, answer is the index of the correct option." + noMath },
          { role: "user", content: `Subject: ${payload.subject}\nLesson title: ${payload.title}\nTopic: ${payload.topic}\nTranscript:\n${transcript}` },
        ];
        out = asJson(await groq(messages, true, MODEL, 2500));
        break;
      }
      case "examlens": {
        const messages = [
          { role: "system", content: "You are ExamLens. You mark one exam answer and classify WHY marks were lost. Return JSON only: {\"score\":0-100,\"cause\":\"conceptual gap|method slip|arithmetic or units|misread the question|blank\",\"verdict\":string,\"explanation\":string,\"correct_working\":string,\"topic\":string}. verdict is one short sentence. explanation is two or three sentences naming the misconception. If the answer is fully correct, cause is \"none\"." + noMath },
          { role: "user", content: `Subject: ${payload.subject}\nTopic given by student: ${payload.topic}\nQuestion: ${payload.question}\nStudent answer: ${payload.answer}\nMark scheme or expected answer: ${payload.expected || "not provided — judge it yourself"}` },
        ];
        out = asJson(await groq(messages, true));
        break;
      }
      case "examlens_ocr": {
        const images: string[] = (Array.isArray(payload.images) ? payload.images : [payload.image]).filter(Boolean);
        if (!images.length) return json({ error: "No image provided" }, 400);
        if (images.length > 3) return json({ error: "Send at most 3 photos" }, 400);
        const content = [
          { type: "text", text: "Transcribe the exam question and the student's own answer exactly as written in the photo(s). Do not solve, correct or improve anything — just read what is on the page. If a mark scheme is visible, transcribe that too." },
          ...images.map((url) => ({ type: "image_url", image_url: { url } })),
        ];
        const messages = [
          { role: "system", content: "You are an exact transcription tool for photographed exam pages. Return JSON only: {\"question\":string,\"answer\":string,\"expected\":string,\"subject_guess\":string,\"topic_guess\":string}. Use an empty string for anything not visible in the photo(s). Never invent working the student didn't write." },
          { role: "user", content },
        ];
        // Groq reserves the full max_tokens against this org's per-minute output
        // budget for this model before generating anything — the default 1200
        // alone exceeds a 1000 OTPM cap, so every call failed regardless of
        // actual output size. The real output here is a small JSON blob.
        out = asJson(await groq(messages, true, MODEL_VISION, 700));
        break;
      }
      case "mirage_generate": {
        const messages = [
          { role: "system", content: "You are Mirage. You test whether mastery is genuine by asking the same idea at five increasing distances from how it is usually taught. Return JSON only: {\"questions\":[{\"level\":1,\"label\":\"Identical form\",\"question\":string,\"expected\":string}]}. Exactly five questions, levels 1 to 5, labels: Identical form, Reworded, New values, New context, Inverse. Each question must be answerable in one or two sentences without a calculator where possible." + noMath },
          { role: "user", content: `Subject: ${payload.subject}\nTopic: ${payload.topic}` },
        ];
        out = asJson(await groq(messages, true));
        break;
      }
      case "mirage_mark": {
        const messages = [
          { role: "system", content: "You mark short answers strictly but fairly. Return JSON only: {\"results\":[{\"level\":1,\"correct\":true,\"score\":0-100,\"note\":string}],\"verdict\":string,\"root_cause\":string}. score reflects partial credit. verdict explains, in two or three sentences, whether the mastery is genuine or pattern-matched, using the pattern across levels." + noMath },
          { role: "user", content: `Topic: ${payload.topic}\n` + (payload.answers ?? []).map((a: any) => `Level ${a.level} (${a.label})\nQ: ${a.question}\nExpected: ${a.expected}\nStudent: ${a.answer || "(blank)"}`).join("\n\n") },
        ];
        out = asJson(await groq(messages, true));
        break;
      }
      case "doctor": {
        const session = payload.session ?? [];
        const sequence = payload.sequence ?? []; // [{subject, course, topics:[in taught order]}], from real lesson positions
        const curriculumBlock = sequence.length
          ? sequence.map((c: any) => `${c.subject} — ${c.course}: ` + c.topics.join(" -> ")).join("\n")
          : "No enrolled course has a lesson sequence yet.";
        const messages = [
          { role: "system", content: `${rules} You are Study Doctor. Separate genuine knowledge gaps from careless slips and pacing problems. ` +
            `You are given the actual taught order of topics in each course the student is enrolled in (earlier topics were taught first, so a weak later topic may really be a gap in an earlier one it depends on) — use that real sequence to spot prerequisite gaps, never guess a prerequisite relationship that isn't shown in it. ` +
            `Then give a short ordered plan of 2 to 3 concrete steps the student can start today, and make exactly one of them a retest of a specific weak topic. ` +
            `Return JSON only: {"findings":[{"kind":"gap|slip|pacing|prereq","title":string,"text":string}],"plan":[{"step":string,"topic":string}]}. ` +
            `Use kind "prereq" only when the taught sequence actually supports it — name both the weak topic and the earlier topic it likely depends on in the finding's text.` },
          { role: "user", content: `Recent work:\n` + session.map((a: any) => `${a.kind} · ${a.topic} · ${a.score}%${a.seconds ? ` · ${a.seconds}s` : ""}`).join("\n") +
            `\n\nTopic scores:\n` + topics.map(t => `${t.topic}: ${t.score}%`).join("\n") +
            `\n\nTaught order per course (this is real, not a guess):\n` + curriculumBlock },
        ];
        out = asJson(await groq(messages, true));
        break;
      }
      case "advisor": {
        const messages = [
          { role: "system", content: `${rules} You are the Profile Advisor. Judge fit from the record, not from what the student wishes. Return JSON only: {"matches":[{"name":string,"fit":0-100,"why":string}],"requirements":[{"title":string,"status":string,"met":boolean}],"todo":[{"title":string,"detail":string}],"blocking":string}. Three to five matches, strongest first.` },
          { role: "user", content: `Goal: ${profile?.goal ?? "not stated"}\nInterests: ${(profile?.interests ?? []).join(", ") || "not stated"}\nTopic scores:\n` + (topics.map(t => `${t.topic} (${t.subject}): ${t.score}%`).join("\n") || "no graded work yet") },
        ];
        out = asJson(await groq(messages, true));
        break;
      }
      case "teacher_chat": {
        /* The teaching assistant. Reads this teacher's own courses and their
           students' results, keeps a running conversation, and maintains a
           small memory of durable facts between sessions. */
        const { data: me } = await sb.from("profiles").select("full_name, role, subject").eq("id", user.id).single();
        if (!me || !["teacher", "admin"].includes(me.role)) return json({ error: "The teaching assistant is for teachers" }, 403);
        const message = String(payload.message ?? "").slice(0, 4000).trim();
        if (!message) throw new Error("Empty message");

        const { data: courses }: any = await sb.from("courses").select("id, title, subject, published").eq("teacher_id", user.id);
        const cids = (courses ?? []).map((c: any) => c.id);
        let lessons: any[] = [], enrol: any[] = [];
        if (cids.length) {
          const [l, e]: any = await Promise.all([
            sb.from("lessons").select("course_id, title, topic, position, published, checkpoint").in("course_id", cids),
            sb.from("enrollments").select("student_id, course_id").in("course_id", cids),
          ]);
          lessons = l.data ?? []; enrol = e.data ?? [];
        }
        const sids = [...new Set(enrol.map((e: any) => e.student_id))];
        let studs: any[] = [], att: any[] = [];
        if (sids.length) {
          const [p, a]: any = await Promise.all([
            sb.from("profiles").select("id, full_name, grade").in("id", sids),
            sb.from("attempts").select("student_id, kind, subject, topic, score, meta, created_at")
              .in("student_id", sids).order("created_at", { ascending: false }).limit(1500),
          ]);
          studs = p.data ?? []; att = a.data ?? [];
        }

        // per-student picture
        const perStudent = studs.map((s: any) => {
          const rows = att.filter((a: any) => a.student_id === s.id);
          const g = genomeSummary(rows);
          const overall = g.length ? Math.round(g.reduce((t: number, x: any) => t + x.score, 0) / g.length) : null;
          const last = rows[0]?.created_at ? new Date(rows[0].created_at).toDateString() : "never";
          return `${s.full_name} (${s.grade ?? "no class"}): ${overall === null ? "no graded work" : `genome ${overall}%`}, ` +
            `${rows.length} attempts, last active ${last}` +
            (g.length ? `; weakest: ${g.slice(0, 2).map((t: any) => `${t.topic} ${t.score}%`).join(", ")}` : "");
        });
        // class-wide patterns
        const byTopic: Record<string, number[]> = {};
        studs.forEach((s: any) => genomeSummary(att.filter((a: any) => a.student_id === s.id))
          .forEach((t: any) => (byTopic[t.topic] ||= []).push(t.score)));
        const topicLines = Object.entries(byTopic)
          .map(([t, sc]) => ({ t, avg: Math.round(sc.reduce((a, b) => a + b, 0) / sc.length), weak: sc.filter(v => v < 60).length, n: sc.length }))
          .sort((a, b) => a.avg - b.avg)
          .map(x => `${x.t}: class average ${x.avg}% across ${x.n} students, ${x.weak} below 60%`);
        const causes: Record<string, number> = {};
        att.filter((a: any) => a.kind === "examlens" && a.meta?.cause && a.meta.cause !== "none")
          .forEach((a: any) => { const k = `${a.topic} — ${a.meta.cause}`; causes[k] = (causes[k] || 0) + 1; });
        const causeLines = Object.entries(causes).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, n]) => `${k} (${n}×)`);
        const falseMastery: Record<string, number> = {};
        att.filter((a: any) => a.kind === "mirage" && a.meta && Number(a.meta.apparent) - Number(a.meta.genuine) >= 25)
          .forEach((a: any) => { falseMastery[a.topic] = (falseMastery[a.topic] || 0) + 1; });
        const courseLines = (courses ?? []).map((c: any) => {
          const ls = lessons.filter((l: any) => l.course_id === c.id).sort((a: any, b: any) => a.position - b.position);
          return `${c.title} [${c.subject}, ${c.published ? "published" : "draft"}, ${enrol.filter((e: any) => e.course_id === c.id).length} students]: ` +
            (ls.map((l: any) => `${l.position}. ${l.title} (${l.topic}${l.checkpoint?.question ? "" : ", no checkpoint"})`).join("; ") || "no lessons yet");
        });

        // memory and conversation so far
        const { data: memory }: any = await sb.from("assistant_memory").select("id, note, source, created_at")
          .eq("teacher_id", user.id).order("created_at", { ascending: true }).limit(80);
        const { data: hist }: any = await sb.from("assistant_messages").select("role, content")
          .eq("teacher_id", user.id).order("created_at", { ascending: false }).limit(16);
        const history = (hist ?? []).reverse().map((m: any) => ({ role: m.role, content: m.content }));

        const system =
          `You are Edu AI, the teaching assistant inside EduNexus, working for ${me.full_name}` +
          `${me.subject ? `, who teaches ${me.subject}` : ""}. Be concise, practical and professional, like an experienced ` +
          `head of department. Use ONLY the class data below for any claim about students or results; if the data doesn't ` +
          `cover something, say so. You can plan lessons, write checkpoint questions, suggest reteaching, draft messages to ` +
          `students or parents, and spot patterns. Use short paragraphs; use a list only when it genuinely helps.` + noMath +
          `\n\nMEMORY. You keep durable notes about this teacher between conversations. Save a note only for things that ` +
          `will still matter next week: their preferences, teaching style, plans, decisions, deadlines, or context about ` +
          `the class that is not already in the data. Never save grades or scores, since those are live data. At most 3 new ` +
          `notes per reply, each one short sentence. If the teacher asks you to remember something, save it. If they ask ` +
          `you to forget something, or a note is now wrong, list its id in forget. Do not repeat notes you already have.` +
          `\n\nReturn JSON only: {"reply":string,"remember":[string],"forget":[string]}.` +
          `\n\nWHAT YOU REMEMBER ABOUT THIS TEACHER:\n` +
          ((memory ?? []).map((m: any) => `[${m.id}] ${m.note}`).join("\n") || "nothing yet") +
          `\n\nCOURSES AND LESSONS:\n${courseLines.join("\n") || "no courses yet"}` +
          `\n\nSTUDENTS (${studs.length}):\n${perStudent.join("\n") || "no students enrolled yet"}` +
          `\n\nTOPICS, WEAKEST FIRST:\n${topicLines.join("\n") || "no graded work yet"}` +
          `\n\nMOST COMMON EXAMLENS ERRORS:\n${causeLines.join("\n") || "none recorded"}` +
          `\n\nFALSE MASTERY FLAGGED BY MIRAGE:\n${Object.entries(falseMastery).map(([t, n]) => `${t} (${n} students)`).join("\n") || "none"}`;

        const res = asJson(await groq([{ role: "system", content: system }, ...history, { role: "user", content: message }], true, MODEL, 1800));
        const reply = String(res.reply ?? "").trim() || "Sorry, I couldn't put an answer together. Try asking again.";
        const known = new Set((memory ?? []).map((m: any) => m.note.toLowerCase()));
        const remember = (Array.isArray(res.remember) ? res.remember : []).map((n: any) => String(n).trim().slice(0, 400))
          .filter((n: string) => n && !known.has(n.toLowerCase())).slice(0, 3);
        const ids = new Set((memory ?? []).map((m: any) => m.id));
        const forget = (Array.isArray(res.forget) ? res.forget : []).map(String).filter((id: string) => ids.has(id));

        await sb.from("assistant_messages").insert([
          { teacher_id: user.id, role: "user", content: message },
          { teacher_id: user.id, role: "assistant", content: reply },
        ]);
        if (remember.length) await sb.from("assistant_memory").insert(remember.map((note: string) => ({ teacher_id: user.id, note, source: "assistant" })));
        if (forget.length) await sb.from("assistant_memory").delete().in("id", forget).eq("teacher_id", user.id);
        const { data: memNow }: any = await sb.from("assistant_memory").select("id, note, source, created_at")
          .eq("teacher_id", user.id).order("created_at", { ascending: true });

        out = { reply, remembered: remember, forgot: forget.length, memory: memNow ?? [],
                context: { students: studs.length, courses: (courses ?? []).length, attempts: att.length } };
        break;
      }
      default:
        return json({ error: `Unknown task: ${task}` }, 400);
    }
    return json(out);
  } catch (err) {
    return json({ error: String((err as Error).message ?? err) }, 500);
  }
});
