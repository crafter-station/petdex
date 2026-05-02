import { CliAuthComplete } from "@/components/cli-auth-complete";

type CliAuthPageProps = {
  searchParams: Promise<{
    callback?: string | string[];
    state?: string | string[];
  }>;
};

export default async function CliAuthPage({ searchParams }: CliAuthPageProps) {
  const params = await searchParams;
  const callback = first(params.callback);
  const state = first(params.state);
  const safeCallback =
    callback && isLoopbackCallback(callback) ? callback : null;

  return (
    <main className="min-h-screen bg-[#f7f8ff] px-6 py-12 text-black">
      <div className="mx-auto flex min-h-[70vh] max-w-xl items-center justify-center">
        <CliAuthComplete callback={safeCallback} state={state ?? null} />
      </div>
    </main>
  );
}

function first(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function isLoopbackCallback(value: string) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "http:" &&
      (url.hostname === "127.0.0.1" || url.hostname === "localhost") &&
      url.pathname === "/callback"
    );
  } catch {
    return false;
  }
}
