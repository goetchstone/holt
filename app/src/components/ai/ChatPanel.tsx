"use client";

// /app/src/components/ai/ChatPanel.tsx
//
// Phase 2 UI for the AI data chatbot. A question box that calls the typed
// chat.ask mutation and renders the three outcomes the endpoint can return
// (lib/ai/askData.ts AskDataResult): the generated SQL plus a result table on
// success, a "refused" notice when the model produced a non-read statement, and
// a surfaced error string when a valid SELECT was rejected by the database.
//
// Reads the mutation state directly off react-query (isPending / isError /
// data) rather than mirroring it into local state, so the panel has one source
// of truth for what to show.

import { useState, type KeyboardEvent } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { api } from "@/lib/trpc/client";

// Values arrive over the wire as bigint / Prisma Decimal / Date / null; React
// cannot render several of those directly, so every cell is coerced to a
// string. null / undefined render as an empty cell rather than the literal
// words "null" / "undefined".
function formatCell(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

export function ChatPanel() {
  const [question, setQuestion] = useState("");
  const ask = api.chat.ask.useMutation();

  const submit = () => {
    const trimmed = question.trim();
    if (!trimmed || ask.isPending) return;
    ask.mutate({ question: trimmed });
  };

  // Enter submits; Shift+Enter inserts a newline.
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const data = ask.data;
  const rows = (data?.rows ?? []) as Record<string, unknown>[];

  return (
    <div className="max-w-4xl space-y-6 font-serif">
      <div className="space-y-2">
        <label htmlFor="aiQuestion" className="block text-xs font-medium text-sh-gray">
          Ask a question about your data
        </label>
        <textarea
          id="aiQuestion"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={onKeyDown}
          rows={3}
          placeholder="e.g. Which five customers have the highest lifetime order total?"
          className="w-full rounded border border-gray-300 px-3 py-2 text-sm"
        />
        <div className="flex items-center gap-3">
          <Button type="button" onClick={submit} disabled={ask.isPending || !question.trim()}>
            {ask.isPending ? "Asking…" : "Ask"}
          </Button>
          <span className="text-xs text-sh-gray">
            Press Enter to ask · Shift+Enter for a new line
          </span>
        </div>
      </div>

      {/* The mutation itself failed (network / tRPC), distinct from a query the
          database rejected. Surface the real message (CLAUDE.md rule 11). */}
      {ask.isError && (
        <Card className="border-red-300">
          <CardContent className="p-4 text-sm text-red-800">
            {ask.error.message || "The request failed."}
          </CardContent>
        </Card>
      )}

      {data && (
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Generated SQL</CardTitle>
            </CardHeader>
            <CardContent className="pt-0">
              <pre className="overflow-x-auto rounded bg-sh-linen p-3 font-mono text-xs text-sh-black">
                {data.sql}
              </pre>
            </CardContent>
          </Card>

          {data.refused ? (
            <Card className="border-amber-300">
              <CardContent className="p-4 text-sm text-amber-800">
                The generated statement was not a read-only SELECT, so nothing was run against the
                database. The SQL above is shown for review only.
              </CardContent>
            </Card>
          ) : data.error ? (
            <Card className="border-red-300">
              <CardContent className="p-4 text-sm text-red-800">{data.error}</CardContent>
            </Card>
          ) : rows.length === 0 ? (
            <Card>
              <CardContent className="p-4 text-sm text-sh-gray">
                The query ran but returned no rows.
              </CardContent>
            </Card>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-sh-gray/20 bg-white shadow-sm">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-sh-gray/20 bg-sh-linen">
                    {data.columns.map((col) => (
                      <th
                        key={col}
                        className="px-4 py-3 text-left font-semibold text-sh-gray whitespace-nowrap"
                      >
                        {col}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, i) => (
                    <tr
                      key={i}
                      className={`border-b border-sh-gray/10 ${i % 2 === 1 ? "bg-sh-stripe" : ""}`}
                    >
                      {data.columns.map((col) => (
                        <td key={col} className="px-4 py-3 align-top text-sh-black">
                          {formatCell(row[col])}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
