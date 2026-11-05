-- Loopback compose credentials only. Provision independent secrets in hosted deployments.
CREATE ROLE specdoc_editor LOGIN PASSWORD 'editor-local-only';
CREATE ROLE specdoc_migrate LOGIN PASSWORD 'migration-local-only';
CREATE ROLE specdoc_board LOGIN PASSWORD 'board-local-only';
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
ALTER SCHEMA public OWNER TO specdoc_editor;
CREATE SCHEMA specdoc_board AUTHORIZATION specdoc_migrate;
REVOKE ALL ON SCHEMA specdoc_board FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO specdoc_migrate WITH GRANT OPTION;
GRANT USAGE ON SCHEMA public TO specdoc_board;
GRANT USAGE ON SCHEMA specdoc_board TO specdoc_board;
ALTER ROLE specdoc_editor IN DATABASE specdoc SET search_path=public,specdoc_board;
ALTER ROLE specdoc_migrate IN DATABASE specdoc SET search_path=specdoc_board,public;
ALTER ROLE specdoc_board IN DATABASE specdoc SET search_path=specdoc_board,public;
ALTER DEFAULT PRIVILEGES FOR ROLE specdoc_editor IN SCHEMA public
  GRANT SELECT,UPDATE,REFERENCES ON TABLES TO specdoc_migrate WITH GRANT OPTION;
