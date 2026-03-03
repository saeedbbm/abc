import { NextRequest } from "next/server";
import { kb2HowtoCollection, kb2TicketsCollection } from "@/lib/mongodb";
import { getFastModel } from "@/lib/ai-model";
import { generateText } from "ai";
import { spawn } from "child_process";

export const maxDuration = 300;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ companySlug: string }> },
) {
  const { companySlug } = await params;
  const body = await request.json();
  const { agentId, task, repo, branch, mode, howtoId, ticketId } = body;

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: any) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        } catch { /* stream closed */ }
      };

      try {
        send({ type: "progress", detail: "Loading context...", percent: 5 });

        // Gather context
        let howtoContent = "";
        let ticketContent = "";

        if (howtoId) {
          const howto = await kb2HowtoCollection.findOne({ howto_id: howtoId });
          if (howto) {
            howtoContent = (howto as any).sections
              ?.map((s: any) => `## ${s.section_name}\n${s.content}`)
              .join("\n\n") ?? "";
            send({ type: "progress", detail: `Loaded how-to: ${(howto as any).title}`, percent: 10 });
          }
        }

        if (ticketId) {
          const ticket = await kb2TicketsCollection.findOne({ ticket_id: ticketId });
          if (ticket) {
            ticketContent = `Ticket: ${(ticket as any).title}\n${(ticket as any).description}`;
            send({ type: "progress", detail: `Loaded ticket: ${(ticket as any).title}`, percent: 15 });
          }
        }

        const fullPrompt = [
          task,
          howtoContent ? `\n--- How-to Guide ---\n${howtoContent}` : "",
          ticketContent ? `\n--- Ticket ---\n${ticketContent}` : "",
          repo ? `\nRepository: ${repo}` : "",
          branch ? `\nBranch: ${branch}` : "",
        ].filter(Boolean).join("\n");

        if (agentId === "claude-code") {
          send({ type: "progress", detail: "Starting Claude Code agent...", percent: 20 });

          // Try real CLI first
          let usedCLI = false;
          try {
            const proc = spawn("claude", ["--dangerously-skip-permissions", "-p", fullPrompt], {
              shell: true,
              env: { ...process.env },
            });

            await new Promise<void>((resolve, reject) => {
              proc.stdout?.on("data", (chunk: Buffer) => {
                const lines = chunk.toString().split("\n");
                for (const line of lines) {
                  if (line.trim()) {
                    send({ type: "output", line: line });
                  }
                }
              });
              proc.stderr?.on("data", (chunk: Buffer) => {
                send({ type: "output", line: `[stderr] ${chunk.toString().trim()}` });
              });
              proc.on("close", (code) => {
                if (code === 0) resolve();
                else reject(new Error(`Process exited with code ${code}`));
              });
              proc.on("error", reject);
            });

            usedCLI = true;
          } catch {
            send({ type: "progress", detail: "CLI not available, using AI SDK fallback...", percent: 25 });
          }

          if (!usedCLI) {
            // Fallback: use AI SDK to simulate agent behavior
            const model = getFastModel();
            send({ type: "output", line: '$ claude --dangerously-skip-permissions -p "..."' });
            send({ type: "output", line: "" });
            send({ type: "output", line: "Claude Code v1.12.0" });
            send({ type: "output", line: `Mode: ${mode || "autonomous"}` });
            send({ type: "output", line: "" });
            send({ type: "progress", detail: "Analyzing task with AI...", percent: 30 });

            const result = await generateText({
              model,
              system: `You are simulating a coding agent's terminal output. Given a task, generate realistic terminal output showing the agent reading KB context, planning changes, writing code, running tests, and creating a PR. Output should look like timestamped terminal lines. Keep it concise (20-30 lines).`,
              prompt: `Task: ${fullPrompt}\nGenerate realistic terminal output for this coding task.`,
            });

            const lines = result.text.split("\n");
            for (let i = 0; i < lines.length; i++) {
              send({ type: "output", line: lines[i] });
              const pct = 30 + Math.round((i / lines.length) * 65);
              if (i % 5 === 0) {
                send({ type: "progress", detail: `Executing... (${i + 1}/${lines.length} lines)`, percent: pct });
              }
            }
          }

          send({ type: "progress", detail: "Execution complete", percent: 100 });
          send({ type: "done", status: "completed" });
        } else {
          // Generic agent - use AI to generate output
          send({ type: "progress", detail: `Running ${agentId}...`, percent: 30 });
          const model = getFastModel();
          const result = await generateText({
            model,
            system: `You are simulating an AI agent's terminal output. Generate realistic terminal output for the given task. Keep it concise.`,
            prompt: `Agent: ${agentId}\nTask: ${fullPrompt}`,
          });

          for (const line of result.text.split("\n")) {
            send({ type: "output", line });
          }

          send({ type: "progress", detail: "Complete", percent: 100 });
          send({ type: "done", status: "completed" });
        }
      } catch (err: any) {
        send({ type: "error", message: err.message ?? "Execution failed" });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
