import type { JSX } from "@shadow-js/web";

export const head = (): { tag: string; children: string }[] => [
  { tag: "title", children: "CLI fixture" },
];

export default function Home(): JSX.Element {
  return (
    <main>
      <h1>Dusk CLI fixture</h1>
    </main>
  );
}
