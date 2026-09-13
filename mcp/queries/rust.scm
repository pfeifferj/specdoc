; Appended after the grammar's tags.scm at load: paths, type positions,
; trait signatures and imports, which carry most cross-file edges in Rust.

(call_expression
    function: (scoped_identifier
        name: (identifier) @name)) @reference.call

(generic_function
    function: (identifier) @name) @reference.call

(scoped_identifier
    path: (identifier) @name) @reference.type

(type_identifier) @name @reference.type

(function_signature_item
    name: (identifier) @name) @definition.method

(use_declaration
    argument: (scoped_identifier
        name: (identifier) @name)) @reference.import

(use_list
    (identifier) @name) @reference.import
