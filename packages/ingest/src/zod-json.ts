/** Minimal Zod -> JSON Schema for the object/array/string/number/boolean/enum/optional/default shapes we use. */
import { z, type ZodTypeAny } from "zod";
export function zodToJsonSchema(s: ZodTypeAny): any {
  const d: any = (s as any)._def;
  switch (d.typeName) {
    case "ZodObject": {
      const props: Record<string, any> = {}; const required: string[] = [];
      for (const [k, v] of Object.entries(d.shape()) as [string, ZodTypeAny][]) { props[k] = zodToJsonSchema(v); if (!(v.isOptional() || (v as any)._def.typeName === "ZodDefault")) required.push(k); }
      return { type: "object", properties: props, required, additionalProperties: false };
    }
    case "ZodArray": return { type: "array", items: zodToJsonSchema(d.type) };
    case "ZodString": return { type: "string" };
    case "ZodNumber": return { type: "number" };
    case "ZodBoolean": return { type: "boolean" };
    case "ZodEnum": return { type: "string", enum: d.values };
    case "ZodLiteral": return { const: d.value };
    case "ZodOptional": case "ZodNullable": return zodToJsonSchema(d.innerType);
    case "ZodDefault": return zodToJsonSchema(d.innerType);
    case "ZodRecord": return { type: "object", additionalProperties: zodToJsonSchema(d.valueType) };
    case "ZodUnion": return { anyOf: d.options.map(zodToJsonSchema) };
    case "ZodEffects": return zodToJsonSchema(d.schema);
    default: return {};
  }
}
export { z };
