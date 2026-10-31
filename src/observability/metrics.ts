type Labels = Record<string, string>;

/** Minimal Prometheus-text counters; enough to quantify behaviour without a dashboard. */
export class Metrics {
  private readonly help = new Map<string, string>();
  private readonly series = new Map<string, Map<string, number>>();

  describe(name: string, help: string): void {
    this.help.set(name, help);
  }

  inc(name: string, labels: Labels = {}, by = 1): void {
    let m = this.series.get(name);
    if (!m) this.series.set(name, (m = new Map()));
    const key = Object.keys(labels)
      .sort()
      .map((k) => `${k}="${String(labels[k]).replace(/[\\"\n]/g, '_')}"`)
      .join(',');
    m.set(key, (m.get(key) ?? 0) + by);
  }

  render(): string {
    const lines: string[] = [];
    for (const [name, m] of [...this.series].sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`# HELP ${name} ${this.help.get(name) ?? name}`, `# TYPE ${name} counter`);
      for (const [labels, value] of m) lines.push(`${name}${labels ? `{${labels}}` : ''} ${value}`);
    }
    return lines.join('\n') + '\n';
  }
}
