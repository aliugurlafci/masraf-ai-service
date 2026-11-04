# SQL Server for the compose stack (contract §19): the official image plus one directory.
# /var/opt/mssql/backups does not exist in the base image, so Docker would create the mount point
# of the mssql-backups volume owned by root and SQL Server (uid 10001) could not write backups
# (BACKUP DATABASE fails with OS error 5). A fresh named volume copies the ownership of this
# image directory. Nothing else changes: same entrypoint, non-root `mssql` user.
ARG MSSQL_IMAGE=mcr.microsoft.com/mssql/server:2022-latest
FROM ${MSSQL_IMAGE}
USER root
RUN install -d -o mssql -g root -m 0770 /var/opt/mssql/backups
USER mssql
