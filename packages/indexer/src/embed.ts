/**
 * Embedder: Voyage 3 when VOYAGE_API_KEY is set, otherwise a deterministic
 * hashed bag-of-words embedding (1024 dims) so similarity still works offline
 * and in tests. Both produce unit-length vectors.
 */
export interface Embedder { embed(text: string): Promise<number[]>; name: string }
const DIM = 1024;

export class HashEmbedder implements Embedder {
  name = "hash-bow";
  async embed(text: string) {
    const v = new Float64Array(DIM);
    for (const tok of text.toLowerCase().split(/[^a-z0-9_.:-]+/).filter((t) => t.length > 1)) {
      let h = 2166136261;
      for (let i = 0; i < tok.length; i++) { h ^= tok.charCodeAt(i); h = Math.imul(h, 16777619); }
      v[Math.abs(h) % DIM] += 1;
    }
    let n = Math.sqrt(v.reduce((a, b) => a + b * b, 0)) || 1;
    return Array.from(v, (x) => x / n);
  }
}

export class VoyageEmbedder implements Embedder {
  name = "voyage-3";
  constructor(private key: string, private model = "voyage-3") {}
  async embed(text: string) {
    const r = await fetch("https://api.voyageai.com/v1/embeddings", {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${this.key}` },
      body: JSON.stringify({ input: [text.slice(0, 32_000)], model: this.model, output_dimension: DIM }),
    });
    if (!r.ok) throw new Error(`voyage ${r.status}`);
    const j = await r.json();
    return j.data[0].embedding as number[];
  }
}

export function defaultEmbedder(): Embedder {
  return process.env.VOYAGE_API_KEY ? new VoyageEmbedder(process.env.VOYAGE_API_KEY) : new HashEmbedder();
}
