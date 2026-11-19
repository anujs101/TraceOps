-- Two databases, two users (environment.md §2, §4 DATABASE_URL examples).
CREATE ROLE demo LOGIN PASSWORD 'demo';
CREATE ROLE traceops LOGIN PASSWORD 'traceops';
CREATE DATABASE demo OWNER demo;
CREATE DATABASE traceops OWNER traceops;
