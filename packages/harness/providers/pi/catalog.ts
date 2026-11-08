import type { Api, Model as PiModel, MutableModels, ThinkingLevel } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { Model } from "@aum/core";
import { createPiModel } from "./model.ts";

// Every model family Pi ships, read from Pi's own catalog, so none has to be named in advance.
// Credentials never pass through here: Pi finds them in the environment or its credential store.

export const REASONING = ["minimal", "low", "medium", "high", "xhigh", "max"] as const satisfies readonly ThinkingLevel[];
export type Reasoning = (typeof REASONING)[number];
export const DEFAULT_REASONING: Reasoning = "medium";

export type PiFamily = { id: string; name: string; keyName: string | undefined };
export type PiModelInfo = { id: string; name: string; reasoning: readonly Reasoning[] };

export class PiCatalog {
    readonly models: MutableModels;
    constructor(models: MutableModels = builtinModels()) { this.models = models; }

    families(): PiFamily[] {
        return this.models.getProviders().map(provider => ({ id: provider.id, name: provider.name, keyName: provider.auth.apiKey?.name }));
    }

    // Pi marks a reasoning level a model does not take with null; a missing entry means the
    // provider's own handling, which counts as accepted.
    modelsOf(family: string): PiModelInfo[] {
        return this.models.getModels(this.#family(family).id).map(info);
    }

    // A credential lookup can stall, so a slow answer counts as "not found" after three seconds.
    async hasCredentials(family: string): Promise<boolean> {
        const found = await Promise.race([
            this.models.checkAuth(this.#family(family).id).catch(() => undefined),
            new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), 3000).unref()),
        ]);
        return found !== undefined;
    }

    // Takes "<family>/<model>". A reasoning level the model does not accept falls back to medium,
    // or the nearest level it does accept; a model that does not reason gets none.
    load(ref: string, options: { reasoning?: Reasoning; apiKey?: string } = {}): { model: Model; reasoning: Reasoning | undefined } {
        const slash = ref.indexOf("/");
        if (slash < 1 || slash === ref.length - 1) throw new Error(`Expected <family>/<model>, such as anthropic/claude-sonnet-5-5; got ${ref}`);
        const family = this.#family(ref.slice(0, slash)), id = ref.slice(slash + 1);
        const model = this.models.getModel(family.id, id);
        if (!model) {
            const known = this.modelsOf(family.id).map(option => option.id);
            throw new Error(`${family.name} has no model ${id}. Known: ${known.slice(0, 12).join(", ")}${known.length > 12 ? `, and ${known.length - 12} more` : ""}`);
        }
        const accepted = info(model).reasoning;
        const reasoning = options.reasoning && accepted.includes(options.reasoning) ? options.reasoning : nearest(accepted);
        return { model: createPiModel({ models: this.models, model, ...(reasoning && { reasoning }), ...(options.apiKey && { apiKey: options.apiKey }) }), reasoning };
    }

    #family(id: string) {
        const provider = this.models.getProviders().find(candidate => candidate.id === id);
        if (!provider) throw new Error(`Pi has no model family ${id}. Known: ${this.families().map(family => family.id).join(", ")}`);
        return provider;
    }
}

function info(model: PiModel<Api>): PiModelInfo {
    const levels = model.thinkingLevelMap;
    return { id: model.id, name: model.name, reasoning: model.reasoning ? REASONING.filter(level => levels?.[level] !== null) : [] };
}

function nearest(accepted: readonly Reasoning[]): Reasoning | undefined {
    const wanted = REASONING.indexOf(DEFAULT_REASONING);
    return [...accepted].sort((a, b) => Math.abs(REASONING.indexOf(a) - wanted) - Math.abs(REASONING.indexOf(b) - wanted))[0];
}
