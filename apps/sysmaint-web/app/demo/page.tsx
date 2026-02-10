"use client";

import { FormEvent, useEffect, useMemo, useRef, useState, type RefObject } from "react";

type DemoUser = "alice" | "bob";

type DirectMessage = {
  version: 1;
  kind: "user.chat.v1";
  messageId: string;
  from: string;
  to: string;
  text: string;
  createdAt: number;
};

type BotMessage = {
  id: string;
  role: "user" | "bot";
  text: string;
};

const sysmaintReadyPrompts = [
  "System status summary in one line.",
  "Are there any active anomalies right now?",
  "Show CPU and memory trend for the last 30 minutes.",
  "Is the relay queue healthy? If not, what should I check first?",
  "Give me a high-severity incident checklist for this stack."
];

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString();
}

function buildAutoStatusPrompt(message: DirectMessage): string {
  return [
    "Auto E2EE health check requested by demo UI.",
    `A Signal direct message was sent from ${message.from} to ${message.to}.`,
    `Message ID: ${message.messageId}`,
    `Timestamp (UTC): ${new Date(message.createdAt).toISOString()}`,
    `Payload length (chars): ${message.text.length}`,
    "Reply in exactly two lines:",
    "1) E2EE: Alice<->Bob session/delivery health.",
    "2) System: relay/users/prekeys/queue/active_ws status with key numbers."
  ].join("\n");
}

function mergeDirectMessages(existing: DirectMessage[], incoming: DirectMessage[]): DirectMessage[] {
  const merged = new Map<string, DirectMessage>();
  for (const msg of existing) {
    merged.set(msg.messageId, msg);
  }
  for (const msg of incoming) {
    merged.set(msg.messageId, msg);
  }
  return Array.from(merged.values()).sort((a, b) => a.createdAt - b.createdAt);
}

function ThreadPanel({
  title,
  owner,
  thread,
  inputValue,
  inputPlaceholder,
  sending,
  onInputChange,
  onSend,
  logRef
}: {
  title: string;
  owner: DemoUser;
  thread: DirectMessage[];
  inputValue: string;
  inputPlaceholder: string;
  sending: boolean;
  onInputChange: (text: string) => void;
  onSend: (event: FormEvent<HTMLFormElement>) => void;
  logRef: RefObject<HTMLDivElement | null>;
}) {
  return (
    <section className="demo-panel">
      <h2>{title}</h2>
      <p className="sub">Signal E2EE channel</p>
      <div className="chat-log" ref={logRef}>
        {thread.length === 0 ? <div className="sub">No direct messages yet.</div> : null}
        {thread.map((msg) => {
          const outbound = msg.from === owner;
          return (
            <div key={msg.messageId} className={`msg ${outbound ? "user" : "bot"}`}>
              <strong>{msg.from}:</strong> {msg.text}
              <div className="sub">{formatTime(msg.createdAt)}</div>
            </div>
          );
        })}
      </div>
      <form onSubmit={onSend}>
        <textarea
          value={inputValue}
          onChange={(event) => onInputChange(event.target.value)}
          placeholder={inputPlaceholder}
        />
        <div style={{ marginTop: 10 }}>
          <button type="submit" disabled={sending || inputValue.trim().length === 0}>
            {sending ? "Sending..." : "Send"}
          </button>
        </div>
      </form>
    </section>
  );
}

export default function DemoPage() {
  const [directMessages, setDirectMessages] = useState<DirectMessage[]>([]);
  const [aliceInput, setAliceInput] = useState("");
  const [bobInput, setBobInput] = useState("");
  const [aliceBusy, setAliceBusy] = useState(false);
  const [bobBusy, setBobBusy] = useState(false);
  const [directError, setDirectError] = useState<string | null>(null);

  const [sysmaintPrompt, setSysmaintPrompt] = useState("");
  const [sysmaintBusy, setSysmaintBusy] = useState(false);
  const [sysmaintMessages, setSysmaintMessages] = useState<BotMessage[]>([]);

  const aliceLogRef = useRef<HTMLDivElement | null>(null);
  const bobLogRef = useRef<HTMLDivElement | null>(null);
  const sysmaintLogRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (aliceLogRef.current) {
      aliceLogRef.current.scrollTop = aliceLogRef.current.scrollHeight;
    }
    if (bobLogRef.current) {
      bobLogRef.current.scrollTop = bobLogRef.current.scrollHeight;
    }
  }, [directMessages]);

  useEffect(() => {
    if (!sysmaintLogRef.current) return;
    sysmaintLogRef.current.scrollTop = sysmaintLogRef.current.scrollHeight;
  }, [sysmaintMessages]);

  useEffect(() => {
    let stop = false;

    const poll = async () => {
      try {
        // Poll only Bob's queue to avoid websocket collision with Alice<->SysMaint chat.
        // Relay permits a single active websocket per client_id.
        const bobRes = await fetch("/api/e2ee/pull?user=bob", { cache: "no-store" });
        if (!bobRes.ok) return;

        const bobPayload = (await bobRes.json()) as { ok: boolean; messages?: DirectMessage[] };
        if (stop) return;
        if (!bobPayload.ok) return;

        const incoming = [...(bobPayload.messages ?? [])];
        if (incoming.length === 0) return;
        setDirectMessages((prev) => mergeDirectMessages(prev, incoming));
      } catch {
        // Silent poll failures are acceptable in the demo; sending path reports explicit errors.
      }
    };

    void poll();
    const timer = setInterval(() => {
      void poll();
    }, 1200);

    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, []);

  const thread = useMemo(() => {
    return directMessages.filter(
      (msg) =>
        (msg.from === "alice" && msg.to === "bob") ||
        (msg.from === "bob" && msg.to === "alice")
    );
  }, [directMessages]);

  const sendDirect = async (from: DemoUser, to: DemoUser, text: string) => {
    const res = await fetch("/api/e2ee/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from, to, text })
    });
    if (!res.ok) {
      const payload = await res.text();
      throw new Error(`HTTP ${res.status} ${payload}`);
    }
    const payload = (await res.json()) as { ok: boolean; message?: DirectMessage; error?: string };
    if (!payload.ok || !payload.message) {
      throw new Error(payload.error ?? "Failed to send direct message.");
    }
    const message = payload.message;
    setDirectMessages((prev) => mergeDirectMessages(prev, [message]));
    void (async () => {
      try {
        const autoPrompt = buildAutoStatusPrompt(message);
        const statusRes = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt: autoPrompt })
        });
        if (!statusRes.ok) {
          const errText = await statusRes.text();
          throw new Error(`HTTP ${statusRes.status} ${errText}`);
        }
        const statusPayload = (await statusRes.json()) as { ok: boolean; requestId?: string; reply?: string };
        if (!statusPayload.ok || !statusPayload.reply) {
          throw new Error("Missing SysMaint auto status reply.");
        }
        setSysmaintMessages((prev) => [
          ...prev,
          {
            id: `auto:${statusPayload.requestId ?? message.messageId}`,
            role: "bot",
            text: `Auto E2EE status (${message.from} -> ${message.to}): ${statusPayload.reply}`
          }
        ]);
      } catch (err) {
        setSysmaintMessages((prev) => [
          ...prev,
          {
            id: `auto-error:${message.messageId}:${Date.now()}`,
            role: "bot",
            text: `Auto E2EE status failed (${message.from} -> ${message.to}): ${err instanceof Error ? err.message : String(err)}`
          }
        ]);
      }
    })();
  };

  const onAliceSend = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = aliceInput.trim();
    if (!text || aliceBusy) return;

    setAliceBusy(true);
    setDirectError(null);
    setAliceInput("");
    try {
      await sendDirect("alice", "bob", text);
    } catch (err) {
      setDirectError(err instanceof Error ? err.message : String(err));
      setAliceInput(text);
    } finally {
      setAliceBusy(false);
    }
  };

  const onBobSend = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = bobInput.trim();
    if (!text || bobBusy) return;

    setBobBusy(true);
    setDirectError(null);
    setBobInput("");
    try {
      await sendDirect("bob", "alice", text);
    } catch (err) {
      setDirectError(err instanceof Error ? err.message : String(err));
      setBobInput(text);
    } finally {
      setBobBusy(false);
    }
  };

  const onSysmaintSend = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = sysmaintPrompt.trim();
    if (!text || sysmaintBusy) return;

    const userMessage: BotMessage = {
      id: `u:${Date.now()}`,
      role: "user",
      text
    };
    setSysmaintMessages((prev) => [...prev, userMessage]);
    setSysmaintPrompt("");
    setSysmaintBusy(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: text })
      });
      if (!res.ok) {
        const payload = await res.text();
        throw new Error(`HTTP ${res.status} ${payload}`);
      }
      const payload = (await res.json()) as { reply: string; requestId: string };
      setSysmaintMessages((prev) => [
        ...prev,
        {
          id: `b:${payload.requestId}`,
          role: "bot",
          text: payload.reply
        }
      ]);
    } catch (err) {
      setSysmaintMessages((prev) => [
        ...prev,
        {
          id: `e:${Date.now()}`,
          role: "bot",
          text: `Error: ${err instanceof Error ? err.message : String(err)}`
        }
      ]);
    } finally {
      setSysmaintBusy(false);
    }
  };

  return (
    <section>
      <h1>E2EE Demo: Alice ↔ Bob + SysMaint</h1>
      <p className="sub">
        Left and right panes demonstrate Signal E2EE direct chat between Alice and Bob. Center pane is SysMaint AI.
      </p>
      {directError ? <p className="sub">Direct chat error: {directError}</p> : null}
      <div className="demo-grid">
        <ThreadPanel
          title="Alice (to Bob)"
          owner="alice"
          thread={thread}
          inputValue={aliceInput}
          inputPlaceholder="Alice writes to Bob..."
          sending={aliceBusy}
          onInputChange={setAliceInput}
          onSend={onAliceSend}
          logRef={aliceLogRef}
        />

        <section className="demo-panel">
          <h2>SysMaint AI</h2>
          <p className="sub">Signal E2EE path: Alice ↔ SysMaint (plus auto status after each Alice/Bob message)</p>
          <div className="chat-log" ref={sysmaintLogRef}>
            {sysmaintMessages.length === 0 ? <div className="sub">No SysMaint messages yet.</div> : null}
            {sysmaintMessages.map((msg) => (
              <div key={msg.id} className={`msg ${msg.role}`}>
                <strong>{msg.role === "user" ? "Alice" : "SysMaint"}:</strong> {msg.text}
              </div>
            ))}
          </div>
          <form onSubmit={onSysmaintSend}>
            <div className="quick-prompts">
              {sysmaintReadyPrompts.map((template) => (
                <button
                  key={template}
                  type="button"
                  className="quick-btn"
                  onClick={() => setSysmaintPrompt(template)}
                  disabled={sysmaintBusy}
                >
                  {template}
                </button>
              ))}
            </div>
            <textarea
              value={sysmaintPrompt}
              onChange={(event) => setSysmaintPrompt(event.target.value)}
              placeholder="Ask SysMaint about status, anomalies, trends..."
            />
            <div style={{ marginTop: 10 }}>
              <button type="submit" disabled={sysmaintBusy || sysmaintPrompt.trim().length === 0}>
                {sysmaintBusy ? "Waiting for encrypted reply..." : "Send to SysMaint"}
              </button>
            </div>
          </form>
        </section>

        <ThreadPanel
          title="Bob (to Alice)"
          owner="bob"
          thread={thread}
          inputValue={bobInput}
          inputPlaceholder="Bob writes to Alice..."
          sending={bobBusy}
          onInputChange={setBobInput}
          onSend={onBobSend}
          logRef={bobLogRef}
        />
      </div>
    </section>
  );
}
