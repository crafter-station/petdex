"use client";

import {
  Tabs,
  TabsIndicator,
  TabsList,
  TabsPanel,
  TabsTab,
} from "@ui-sdk/react/tabs";

import { CopyTokenButton } from "@/components/brand/copy-token-button";

type Snippet = {
  id: string;
  label: string;
  code: string;
};

type ToySnippetTabsProps = {
  snippets: readonly Snippet[];
  copyLabel: string;
  copiedLabel: string;
};

export function ToySnippetTabs({
  snippets,
  copyLabel,
  copiedLabel,
}: ToySnippetTabsProps) {
  return (
    <Tabs defaultValue={snippets[0]?.id} className="toy-shell p-4 md:p-6">
      <TabsList className="relative inline-flex flex-wrap gap-1 rounded-2xl bg-shell-pearl-edge/70 p-1 shadow-[inset_0_2px_4px_rgba(16,25,68,0.15)]">
        <TabsIndicator className="absolute top-[var(--active-tab-top)] left-[var(--active-tab-left)] h-[var(--active-tab-height)] w-[var(--active-tab-width)] rounded-xl bg-toy-volt shadow-[inset_0_2px_0_rgba(255,255,255,0.6),0_3px_0_#C9A91F] transition-all duration-200 [transition-timing-function:var(--ease-bounce)]" />
        {snippets.map((snippet) => (
          <TabsTab
            key={snippet.id}
            value={snippet.id}
            className="relative z-10 rounded-xl px-3.5 py-1.5 text-sm font-semibold text-toy-ink/60 transition-colors data-[selected]:text-[#101944]"
          >
            {snippet.label}
          </TabsTab>
        ))}
      </TabsList>
      {snippets.map((snippet) => (
        <TabsPanel key={snippet.id} value={snippet.id} className="mt-4">
          <div className="toy-screen relative p-4">
            <div className="absolute top-3 right-3">
              <CopyTokenButton
                value={snippet.code}
                label={copyLabel}
                copiedLabel={copiedLabel}
              />
            </div>
            <pre className="max-h-64 overflow-auto pr-24 text-xs leading-5 text-[#C9D3FF]">
              <code style={{ fontFamily: "var(--font-geist-mono), monospace" }}>
                {snippet.code}
              </code>
            </pre>
          </div>
        </TabsPanel>
      ))}
    </Tabs>
  );
}
