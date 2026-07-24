declare module "json-schema" {
  export interface JSONSchema7 {
    [key: string]: unknown;
  }

  export type JSONSchema7Definition = boolean | JSONSchema7;
}
