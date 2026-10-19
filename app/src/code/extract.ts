/**
 * One file in, its definitions and references out: the pure, file-local half of the index.
 *
 * A definition is a symbol with a path-scoped name (`Cache.get`), a kind, its lines, a
 * signature and a hash of its text. A reference is something a definition does to a name:
 * calls it, imports it, extends or implements it. Tying a reference to the definition it
 * means is the index's job (`index.ts`), across files and at query time.
 *
 * The type part is deliberately small: as the walk goes it records what type each variable,
 * parameter and field was declared or constructed with (`const s = new Store()`, `s: Store`,
 * `self.s = Store()`, `let s = Store::new()`, `s := &Store{}`), so a call `s.put()` names
 * `Store` as its receiver and can be tied to `Store.put` rather than to every `put`.
 * Nothing is guessed: a receiver whose type was never written down stays unknown.
 */
import type { Node, Parser } from "@vscode/tree-sitter-wasm";
import type { LangId } from "./languages.ts";

export type SymbolKind = "class" | "interface" | "struct" | "trait" | "enum" | "type" | "function" | "method" | "module";
export type RefKind = "call" | "import" | "extends" | "implements";

export interface Definition {
  /** Path-scoped name: `Cache.get`; a second definition of the same name gets `~2`. */
  qname: string;
  name: string;
  kind: SymbolKind;
  /** The enclosing type or module's qname, or "" at the top of the file. */
  parent: string;
  line: number;
  endLine: number;
  signature: string;
  exported: boolean;
  /** Changes whenever the definition's text does. */
  hash: string;
}

export interface Reference {
  /** The innermost definition the reference sits in, or "" at the top of the file. */
  from: string;
  kind: RefKind;
  /** What is called, imported (a module specifier), extended or implemented. */
  name: string;
  /** For a call through a receiver (`x.put()`): the receiver's type when it is known. */
  recvType: string;
  /** A call through a receiver at all, typed or not. */
  member: boolean;
  line: number;
}

export interface Extracted {
  definitions: Definition[];
  references: Reference[];
}

const SIGNATURE_MAX = 200;

interface Scope {
  qname: string;
  /** What defined this scope, so a function inside a class is known to be a method. */
  kind?: SymbolKind;
  /** The type `this`/`self` means in here, when there is one. */
  self: string;
}

/** `&mut Vec<Foo>` → `Vec`, `*pkg.Store` → `Store`, `Store[]` → `Store`: the named type, or "". */
export function typeName(text: string): string {
  let t = text.trim().replace(/^:\s*/, "");
  t = t.replace(/^(?:&\s*(?:mut\s+)?|\*+|\[\]|\.\.\.|readonly\s+)+/, "");
  t = t.replace(/<.*$/s, "").replace(/\[.*$/s, "").replace(/\s*\|.*$/s, "").replace(/\?$/, "");
  const last = t.split(/::|\./).pop() ?? "";
  return /^[A-Za-z_]\w*$/.test(last) ? last : "";
}

const capitalized = (s: string) => /^[A-Z]/.test(s);

function signatureOf(source: string, node: Node, upTo?: Node | null): string {
  const end = upTo && upTo.startIndex > node.startIndex ? upTo.startIndex : node.endIndex;
  const text = source.slice(node.startIndex, end).replace(/\s+/g, " ").trim().replace(/[{:=]\s*$/, "").trim();
  return text.length > SIGNATURE_MAX ? `${text.slice(0, SIGNATURE_MAX)}…` : text;
}

function hashOf(text: string): string {
  return Bun.hash(text).toString(36);
}

/** What a definition node is, in this language, or undefined when it is not one. */
function defKind(lang: LangId, node: Node, scope: Scope, inType: boolean): SymbolKind | undefined {
  const t = node.type;
  switch (lang) {
    case "typescript":
    case "tsx":
    case "javascript":
      if (t === "class_declaration" || t === "abstract_class_declaration" || (t === "class" && node.childForFieldName("name"))) return "class";
      if (t === "function_declaration" || t === "generator_function_declaration") return "function";
      if (t === "method_definition" || t === "method_signature" || t === "abstract_method_signature") return "method";
      if (t === "interface_declaration") return "interface";
      if (t === "type_alias_declaration") return "type";
      if (t === "enum_declaration") return "enum";
      if (t === "variable_declarator" || t === "public_field_definition") {
        const value = node.childForFieldName("value")?.type;
        if (value === "arrow_function" || value === "function_expression" || value === "function") return t === "public_field_definition" ? "method" : "function";
      }
      return undefined;
    case "python":
      if (t === "class_definition") return "class";
      if (t === "function_definition") return inType ? "method" : "function";
      return undefined;
    case "rust":
      if (t === "function_item" || t === "function_signature_item") return inType || scope.self ? "method" : "function";
      if (t === "struct_item") return "struct";
      if (t === "enum_item") return "enum";
      if (t === "trait_item") return "trait";
      if (t === "type_item") return "type";
      if (t === "mod_item") return "module";
      return undefined;
    case "go":
      if (t === "function_declaration") return "function";
      if (t === "method_declaration" || t === "method_elem") return "method";
      if (t === "type_spec") {
        const ty = node.childForFieldName("type")?.type;
        return ty === "struct_type" ? "struct" : ty === "interface_type" ? "interface" : "type";
      }
      return undefined;
  }
}

function exportedOf(lang: LangId, node: Node, name: string): boolean {
  switch (lang) {
    case "python":
      return !name.startsWith("_");
    case "go":
      return capitalized(name);
    case "rust":
      return node.namedChildren.some((c) => c?.type === "visibility_modifier");
    default: {
      for (let p = node.parent, hops = 0; p && hops < 3; p = p.parent, hops++) if (p.type === "export_statement") return true;
      return false;
    }
  }
}

const TYPE_KINDS = new Set<SymbolKind>(["class", "interface", "struct", "trait", "enum"]);

export function extract(parser: Parser, lang: LangId, source: string): Extracted {
  const tree = parser.parse(source);
  if (!tree) return { definitions: [], references: [] };
  const definitions: Definition[] = [];
  const references: Reference[] = [];
  const seen = new Map<string, number>();
  /** `<scope qname>|<variable>` → type, and `<type>|<field>` → type for fields. */
  const vars = new Map<string, string>();
  const fields = new Map<string, string>();
  const stack: Scope[] = [{ qname: "", self: "" }];
  const top = () => stack[stack.length - 1]!;
  /** The innermost definition, which is what a reference is attributed to. */
  const owners: string[] = [""];

  const bind = (name: string, type: string) => {
    if (name && type) vars.set(`${top().qname}|${name}`, type);
  };
  const lookup = (name: string): string => {
    for (let i = stack.length - 1; i >= 0; i--) {
      const hit = vars.get(`${stack[i]!.qname}|${name}`);
      if (hit) return hit;
    }
    return "";
  };
  const bindField = (field: string, type: string) => {
    if (top().self && field && type) fields.set(`${top().self}|${field}`, type);
  };

  /** The type an expression used as a receiver has, when the code says so. */
  const recvTypeOf = (n: Node | null): string => {
    if (!n) return "";
    switch (n.type) {
      case "this":
      case "self":
        return top().self;
      case "identifier": {
        if ((n.text === "self" || n.text === "cls") && lang === "python") return top().self;
        return lookup(n.text) || (capitalized(n.text) && lang !== "go" ? n.text : "");
      }
      case "member_expression":
      case "attribute":
      case "field_expression":
      case "selector_expression": {
        const obj = n.childForFieldName("object") ?? n.childForFieldName("value") ?? n.childForFieldName("operand");
        const prop = n.childForFieldName("property") ?? n.childForFieldName("attribute") ?? n.childForFieldName("field");
        const owner = recvTypeOf(obj);
        return owner && prop ? (fields.get(`${owner}|${prop.text}`) ?? "") : "";
      }
      case "new_expression":
        return typeName(n.childForFieldName("constructor")?.text ?? "");
      case "parenthesized_expression":
        return recvTypeOf(n.namedChildren[0] ?? null);
      default:
        return "";
    }
  };

  /** The type a value has when it is constructed in plain sight: `new X()`, `X()`, `X::new()`, `&X{}`. */
  const constructed = (v: Node | null): string => {
    if (!v) return "";
    if (v.type === "new_expression") return typeName(v.childForFieldName("constructor")?.text ?? "");
    if (v.type === "await_expression") return constructed(v.namedChildren[0] ?? null);
    if (v.type === "call" || v.type === "call_expression") {
      const f = v.childForFieldName("function");
      if (!f) return "";
      if (f.type === "identifier" && capitalized(f.text)) return f.text;
      if (f.type === "scoped_identifier") {
        const path = f.childForFieldName("path")?.text ?? "";
        const t = typeName(path);
        return capitalized(t) ? t : "";
      }
      return "";
    }
    if (v.type === "struct_expression") return typeName(v.childForFieldName("name")?.text ?? "");
    if (v.type === "composite_literal") return typeName(v.childForFieldName("type")?.text ?? "");
    if (v.type === "unary_expression") return constructed(v.childForFieldName("operand"));
    if (v.type === "identifier") return lookup(v.text);
    return "";
  };

  const ref = (kind: RefKind, name: string, line: number, recvType = "", member = false) => {
    if (name) references.push({ from: owners[owners.length - 1]!, kind, name, recvType, member, line });
  };

  const call = (n: Node) => {
    const f = n.childForFieldName("function") ?? n.childForFieldName("constructor");
    if (!f) return;
    const line = n.startPosition.row + 1;
    if (n.type === "new_expression") return ref("call", typeName(f.text), line);
    switch (f.type) {
      case "identifier":
        return ref("call", f.text, line);
      case "member_expression":
      case "attribute":
      case "field_expression":
      case "selector_expression": {
        const obj = f.childForFieldName("object") ?? f.childForFieldName("value") ?? f.childForFieldName("operand");
        const prop = f.childForFieldName("property") ?? f.childForFieldName("attribute") ?? f.childForFieldName("field");
        if (prop) ref("call", prop.text, line, recvTypeOf(obj), true);
        return;
      }
      case "scoped_identifier": {
        const name = f.childForFieldName("name")?.text ?? "";
        const path = typeName(f.childForFieldName("path")?.text ?? "");
        return capitalized(path) ? ref("call", name, line, path, true) : ref("call", name, line);
      }
    }
  };

  const bindings = (n: Node) => {
    switch (n.type) {
      // TypeScript / JavaScript
      case "variable_declarator": {
        const name = n.childForFieldName("name");
        if (name?.type === "identifier") bind(name.text, typeName(n.childForFieldName("type")?.text ?? "") || constructed(n.childForFieldName("value")));
        return;
      }
      case "required_parameter":
      case "optional_parameter": {
        const name = n.childForFieldName("pattern");
        const type = typeName(n.childForFieldName("type")?.text ?? "");
        if (name?.type === "identifier") {
          bind(name.text, type);
          // `constructor(private store: Store)` is also a field.
          if (n.namedChildren.some((c) => c?.type === "accessibility_modifier")) {
            const cls = stack[stack.length - 2];
            if (cls?.self && type) fields.set(`${cls.self}|${name.text}`, type);
          }
        }
        return;
      }
      case "public_field_definition": {
        const name = n.childForFieldName("name");
        if (name) bindField(name.text, typeName(n.childForFieldName("type")?.text ?? "") || constructed(n.childForFieldName("value")));
        return;
      }
      // Python
      case "assignment": {
        const left = n.childForFieldName("left");
        const type = typeName(n.childForFieldName("type")?.text ?? "") || constructed(n.childForFieldName("right"));
        if (left?.type === "identifier") bind(left.text, type);
        else if (left?.type === "attribute" && left.childForFieldName("object")?.text === "self") {
          const attr = left.childForFieldName("attribute")?.text ?? "";
          const cls = stack.findLast((s) => s.self);
          if (cls && type) fields.set(`${cls.self}|${attr}`, type);
        }
        return;
      }
      case "typed_parameter":
      case "typed_default_parameter": {
        const name = n.childForFieldName("name") ?? n.namedChildren.find((c) => c?.type === "identifier");
        if (name) bind(name.text, typeName(n.childForFieldName("type")?.text ?? ""));
        return;
      }
      // Rust
      case "let_declaration": {
        const pat = n.childForFieldName("pattern");
        const name = pat?.type === "mut_pattern" ? pat.namedChildren[0] : pat;
        if (name?.type === "identifier") bind(name.text, typeName(n.childForFieldName("type")?.text ?? "") || constructed(n.childForFieldName("value")));
        return;
      }
      case "parameter": {
        const pat = n.childForFieldName("pattern");
        const name = pat?.type === "mut_pattern" ? pat.namedChildren[0] : pat;
        if (name?.type === "identifier") bind(name.text, typeName(n.childForFieldName("type")?.text ?? ""));
        return;
      }
      case "field_declaration": {
        // Rust struct fields and Go struct fields: `name: Type` / `name Type`.
        const type = typeName(n.childForFieldName("type")?.text ?? "");
        for (const c of n.namedChildren) if (c?.type === "field_identifier") bindField(c.text, type);
        return;
      }
      // Go
      case "parameter_declaration":
      case "var_spec": {
        const type = typeName(n.childForFieldName("type")?.text ?? "") || constructed(n.childForFieldName("value"));
        for (const c of n.namedChildren) if (c?.type === "identifier") bind(c.text, type);
        return;
      }
      case "short_var_declaration": {
        const left = n.childForFieldName("left")?.namedChildren ?? [];
        const right = n.childForFieldName("right")?.namedChildren ?? [];
        left.forEach((l, i) => {
          if (l?.type === "identifier") bind(l.text, constructed(right[i] ?? null));
        });
        return;
      }
    }
  };

  const heritage = (n: Node) => {
    const line = n.startPosition.row + 1;
    switch (n.type) {
      case "extends_clause":
        for (const c of n.namedChildren) if (c && c.type !== "type_arguments") ref("extends", typeName(c.text), line);
        return;
      case "implements_clause":
      case "extends_type_clause":
        for (const c of n.namedChildren) if (c) ref(n.type === "implements_clause" ? "implements" : "extends", typeName(c.text), line);
        return;
    }
  };

  const imports = (n: Node) => {
    const line = n.startPosition.row + 1;
    switch (n.type) {
      case "import_statement":
        if (lang === "python") {
          for (const c of n.namedChildren) if (c?.type === "dotted_name") ref("import", c.text, line);
          else if (c?.type === "aliased_import") ref("import", c.childForFieldName("name")?.text ?? "", line);
        } else {
          const src = n.childForFieldName("source");
          if (src) ref("import", src.text.replace(/^['"]|['"]$/g, ""), line);
        }
        return;
      case "export_statement": {
        const src = n.childForFieldName("source");
        if (src) ref("import", src.text.replace(/^['"]|['"]$/g, ""), line);
        return;
      }
      case "import_from_statement":
        ref("import", n.childForFieldName("module_name")?.text ?? "", line);
        return;
      case "import_spec":
        ref("import", (n.childForFieldName("path")?.text ?? "").replace(/^"|"$/g, ""), line);
        return;
      case "use_declaration":
        ref("import", n.childForFieldName("argument")?.text ?? "", line);
        return;
    }
  };

  const visit = (n: Node) => {
    const inType = TYPE_KINDS.has(top().kind ?? "function");
    const kind = defKind(lang, n, top(), inType);
    let pushed = false;

    if (kind) {
      const nameNode = n.childForFieldName("name");
      const name = nameNode?.text ?? "";
      if (name) {
        let parent = top().qname;
        let self = top().self;
        // A Go method belongs to its receiver's type.
        if (lang === "go" && n.type === "method_declaration") {
          const recv = n.childForFieldName("receiver")?.namedChildren.find((c) => c?.type === "parameter_declaration");
          self = typeName(recv?.childForFieldName("type")?.text ?? "");
          parent = self;
        }
        let qname = parent ? `${parent}.${name}` : name;
        const count = (seen.get(qname) ?? 0) + 1;
        seen.set(qname, count);
        if (count > 1) qname = `${qname}~${count}`;
        const body = n.childForFieldName("body") ?? (n.type === "variable_declarator" || n.type === "public_field_definition" ? n.childForFieldName("value")?.childForFieldName("body") : null);
        definitions.push({
          qname,
          name,
          kind,
          parent,
          line: n.startPosition.row + 1,
          endLine: n.endPosition.row + 1,
          signature: signatureOf(source, n, kind === "type" || kind === "enum" ? null : body),
          exported: exportedOf(lang, n.type === "variable_declarator" ? (n.parent ?? n) : n, name),
          hash: hashOf(n.text),
        });
        stack.push({ qname, kind, self: TYPE_KINDS.has(kind) ? name : self });
        owners.push(qname);
        pushed = true;
        if (lang === "go" && n.type === "method_declaration") {
          const recv = n.childForFieldName("receiver")?.namedChildren.find((c) => c?.type === "parameter_declaration");
          const rname = recv?.childForFieldName("name")?.text;
          if (rname) bind(rname, self);
        }
        if (n.type === "class_definition") {
          for (const c of n.childForFieldName("superclasses")?.namedChildren ?? []) if (c && c.type !== "keyword_argument") ref("extends", typeName(c.text), c.startPosition.row + 1);
        }
      }
    } else if (lang === "rust" && n.type === "impl_item") {
      // An impl block is not a definition; it says what `self` is for the methods inside.
      const self = typeName(n.childForFieldName("type")?.text ?? "");
      const trait = typeName(n.childForFieldName("trait")?.text ?? "");
      if (trait && self) references.push({ from: self, kind: "implements", name: trait, recvType: "", member: false, line: n.startPosition.row + 1 });
      stack.push({ qname: self, self, kind: "struct" });
      for (const c of n.namedChildren) if (c) visit(c);
      stack.pop();
      return;
    }

    if (n.type === "call_expression" || n.type === "call" || n.type === "new_expression") call(n);
    bindings(n);
    heritage(n);
    imports(n);

    for (const c of n.namedChildren) if (c) visit(c);

    if (pushed) {
      stack.pop();
      owners.pop();
    }
  };

  try {
    visit(tree.rootNode);
  } finally {
    tree.delete();
  }
  return { definitions, references };
}
