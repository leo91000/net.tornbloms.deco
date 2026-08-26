declare module 'asn1.js' {
  import type BN from 'bn.js';

  export interface DefinitionBuilder {
    seq(): DefinitionBuilder;
    obj(...items: DefinitionBuilder[]): DefinitionBuilder;
    key(name: string): DefinitionBuilder;
    int(): DefinitionBuilder;
  }

  export interface Entity {
    encode(value: Record<string, BN>, encoding: 'der'): Buffer;
  }

  export function define(
    name: string,
    body: (this: DefinitionBuilder) => void,
  ): Entity;
}
