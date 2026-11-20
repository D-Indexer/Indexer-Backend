/** A claimed Folder identity (contract event `folder_cl`). */
export interface Folder {
  owner: string;
  name: string;
  /** Owner's selected template (`tmpl_set` / `port_mint`), null until one is chosen. */
  templateId: number | null;
  claimedAt: Date;
  updatedAt: Date;
}

/** A registered template (contract event `tmpl_reg`). */
export interface Template {
  id: number;
  metadataUri: string;
  creator: string | null;
  registeredAt: Date;
}

/** A minted portfolio NFT (contract events `port_mint` / `port_upd` / `tmpl_set`). */
export interface Portfolio {
  owner: string;
  templateId: number;
  /** Canonical CIDv1 base32, or null when the on-chain string is not a parseable CID. */
  ipfsCid: string | null;
  /** Original on-chain CID string, preserved verbatim. */
  ipfsCidRaw: string;
  /** Whether the on-chain CID string parsed successfully. */
  cidValid: boolean;
  mintedAt: Date;
  updatedAt: Date;
}