ALTER TABLE issue_view
    DROP CONSTRAINT issue_view_scope_variant_check,
    DROP CONSTRAINT issue_view_scope_variant_pairing;

ALTER TABLE issue_view
    ADD CONSTRAINT issue_view_scope_variant_check CHECK (
        scope_variant IN ('assigned', 'created', 'involved', 'any')
    ),
    ADD CONSTRAINT issue_view_check1 CHECK (
        (scope_type = 'my' AND scope_variant IS NOT NULL)
        OR (scope_type <> 'my' AND scope_variant IS NULL)
    );
