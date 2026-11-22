import { Lightbulb } from "lucide-react";

import type { PetIdea } from "@/lib/ideas";

type IdeasQueueProps = {
  ideas: PetIdea[];
};

export function IdeasQueue({ ideas }: IdeasQueueProps) {
  if (ideas.length === 0) {
    return null;
  }

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="toy-tag text-brand">Hatch queue</p>
          <h2 className="mt-2 text-2xl font-semibold text-foreground">
            Planned pets
          </h2>
        </div>
        <div className="rounded-xl border border-[#D4DCF4] bg-surface px-3 py-1.5 text-xs font-medium text-muted-2 dark:border-white/12">
          {ideas.length} ideas
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
        {ideas.map((idea) => (
          <article
            key={idea.id}
            className="toy-shell rounded-2xl border border-[#D4DCF4] p-4 dark:border-white/12"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="rounded-xl bg-amber-50 p-2 text-amber-800 dark:bg-amber-950/40">
                <Lightbulb className="size-4" />
              </div>
              <span className="toy-tag rounded-xl bg-surface-muted px-2 py-1 text-muted-2">
                {idea.featured ? "featured" : idea.status}
              </span>
            </div>
            <h3 className="mt-4 font-semibold text-foreground">{idea.name}</h3>
            <p className="mt-2 line-clamp-3 text-sm leading-6 text-muted-2">
              {idea.description}
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              {idea.tags.slice(0, 3).map((tag) => (
                <span
                  key={tag}
                  className="rounded-xl bg-cyan-50 px-2 py-1 text-xs font-medium text-cyan-800 dark:bg-cyan-950/40 dark:text-cyan-300"
                >
                  {tag}
                </span>
              ))}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
