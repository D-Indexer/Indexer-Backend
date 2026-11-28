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
  /** Number of minted portfolios currently using this template. */
  usageCount: number;
}

/** A portfolio as listed under its template (`GET /templates/:id/portfolios`). */
export interface TemplatePortfolio {
  owner: string;
  templateId: number;
  ipfsCid: string;
  mintedAt: Date;
  updatedAt: Date;
}

/** A minted portfolio NFT (contract events `port_mint` / `port_upd` / `tmpl_set`). */
export interface Portfolio {
  /** Stable portfolio identifier (NFT token id); primary key. */
  tokenId: number;
  /** Current owner; indexed attribute, may change on transfer. */
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

/** A recorded ownership change for a portfolio (contract event `port_xfer`). */
export interface PortfolioOwnershipHistory {
  /** Stable portfolio identifier (NFT token id). */
  tokenId: number;
  /** Previous owner, null for the initial mint record. */
  fromOwner: string | null;
  /** New owner after the transfer. */
  toOwner: string;
  /** Ledger timestamp of the ownership change. */
  transferredAt: Date;
}
