// The model can send any JSON, whatever the tool's schema says. Each tool reads its arguments
// through Args, so a wrong, missing or unknown field fails before anything runs, with a message
// the model can act on in its next reply.
export class Args {
    readonly #values: Record<string, unknown>;
    readonly #where: string;

    constructor(raw: unknown, allowed: readonly string[], where = "Arguments") {
        // Pi hands over the raw text when the model's arguments were not valid JSON, so the model
        // gets to see what it actually sent.
        if (typeof raw === "string") throw new Error(`${where} must be a JSON object. Received: ${raw}`);
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${where} must be a JSON object`);
        const unknown = Object.keys(raw).filter(key => !allowed.includes(key));
        if (unknown.length) throw new Error(`${where} has unknown field ${unknown.join(", ")}; allowed: ${allowed.join(", ")}`);
        this.#values = raw as Record<string, unknown>;
        this.#where = where;
    }

    string(key: string): string {
        const value = this.#values[key];
        if (typeof value !== "string") throw new Error(`${this.#where}: ${key} must be a string`);
        return value;
    }

    integer(key: string, min: number, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
        const value = this.#values[key] ?? fallback;
        if (!Number.isInteger(value) || (value as number) < min || (value as number) > max)
            throw new Error(`${this.#where}: ${key} must be a whole number from ${min} to ${max}`);
        return value as number;
    }

    list(key: string): unknown[] {
        const value = this.#values[key];
        if (!Array.isArray(value)) throw new Error(`${this.#where}: ${key} must be an array`);
        return value;
    }
}
