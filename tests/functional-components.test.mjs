// Reuse the real functional assertions with browser-only component mounting.
process.env.AURAL_FUNCTIONAL_COMPONENT_ONLY = "1";
await import("./functional.test.ts");
