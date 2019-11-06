#!/usr/bin/env bash
docker pull amazonlinux
git clone git@github.com:tjpatter/getpass.git $(pwd)/tmp/getpass
mkdir -p $(pwd)/bin/getpass
cat <<-COMMAND | docker run -v $(pwd)/tmp/getpass:/getpass -v $(pwd)/bin/getpass:/output -i amazonlinux /bin/bash
  yum -y groupinstall "Development Tools"
  yum -y install openssl-devel
  cd /getpass
  cc -g -I./include -DUNIX -c -o getpass.o getpass.c
  cc -o getpass getpass.o -L./lib64 -lldapsdk -lpthread -lresolv -ldl -lldapssl -lcrypto
  cp -R getpass lib64 /output
COMMAND
rm -rf $(pwd)/tmp/getpass
