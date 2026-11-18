export interface ForeignKeyRow {
  readonly child_table: string;
  readonly id: number;
  readonly parent_table: string;
  readonly from: string;
  readonly to: string | null;
}

export interface ForeignKeyConstraint {
  readonly parentTable: string;
  readonly columns: ReadonlyArray<{ readonly from: string; readonly to: string | null }>;
}

export interface ForeignKeyViolation {
  readonly table: string;
  readonly rowid: number | null;
  readonly parent: string;
  readonly fkid: number;
}

export const quoteIdent = (identifier: string) => `"${identifier.replaceAll('"', '""')}"`;

export const groupForeignKeys = (rows: ReadonlyArray<ForeignKeyRow>) => {
  const byTable = new Map<string, Map<number, ForeignKeyConstraint>>();
  for (const row of rows) {
    let constraints = byTable.get(row.child_table);
    if (constraints === undefined) {
      constraints = new Map();
      byTable.set(row.child_table, constraints);
    }
    const existing = constraints.get(row.id);
    const column = { from: row.from, to: row.to };
    constraints.set(
      row.id,
      existing === undefined
        ? { parentTable: row.parent_table, columns: [column] }
        : { ...existing, columns: [...existing.columns, column] },
    );
  }
  return new Map(
    Array.from(byTable, ([table, constraints]) => [table, Array.from(constraints.values())]),
  );
};

export const orderTablesParentsFirst = <T extends { readonly name: string }>(
  tables: ReadonlyArray<T>,
  foreignKeys: ReadonlyMap<string, ReadonlyArray<ForeignKeyConstraint>>,
): Array<T> => {
  const byName = new Map(tables.map((table) => [table.name, table]));
  const visited = new Set<string>();
  const ordered: Array<T> = [];
  const visit = (table: T) => {
    if (visited.has(table.name)) return;
    visited.add(table.name);
    for (const fk of foreignKeys.get(table.name) ?? []) {
      if (fk.parentTable === table.name) continue;
      const parent = byName.get(fk.parentTable);
      if (parent !== undefined) visit(parent);
    }
    ordered.push(table);
  };
  for (const table of tables) visit(table);
  return ordered;
};

export const parentExistsPredicates = (
  childTable: string,
  constraints: ReadonlyArray<ForeignKeyConstraint>,
  primaryKeys: ReadonlyMap<string, ReadonlyArray<string>>,
  options?: { readonly includeSelf?: boolean },
): Array<string> => {
  const childRef = quoteIdent(childTable);
  return constraints.flatMap((fk) => {
    // A self-reference cannot be filtered while the table is being inserted:
    // the parent row is still in the source, not in main. Delete it afterwards.
    if (fk.parentTable === childTable && options?.includeSelf !== true) return [];
    const parentPks = primaryKeys.get(fk.parentTable) ?? [];
    const resolved = fk.columns.flatMap((col, idx) => {
      const to = col.to ?? parentPks[idx];
      return to === undefined ? [] : [{ from: col.from, to }];
    });
    if (resolved.length !== fk.columns.length) return [];
    const nullable = resolved.map((col) => `${childRef}.${quoteIdent(col.from)} IS NULL`);
    const matches = resolved.map(
      (col) => `parent.${quoteIdent(col.to)} = ${childRef}.${quoteIdent(col.from)}`,
    );
    return [
      `(${[
        ...nullable,
        `EXISTS (SELECT 1 FROM main.${quoteIdent(fk.parentTable)} AS parent WHERE ${matches.join(" AND ")})`,
      ].join(" OR ")})`,
    ];
  });
};

export const describeForeignKeyViolations = (violations: ReadonlyArray<ForeignKeyViolation>) => {
  const sample = violations
    .slice(0, 12)
    .map((row) => `${row.table} row ${row.rowid ?? "without rowid"} -> ${row.parent}`)
    .join("; ");
  const extra = violations.length > 12 ? `; and ${violations.length - 12} more` : "";
  return `${violations.length} dangling foreign key${violations.length === 1 ? "" : "s"} (${sample}${extra})`;
};
