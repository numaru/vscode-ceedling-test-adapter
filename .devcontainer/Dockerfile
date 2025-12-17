FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      sudo && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/* && \
    echo 'ubuntu ALL=(ALL) NOPASSWD:ALL' >> /etc/sudoers

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      build-essential \
      ca-certificates \
      curl \
      libffi-dev \
      libyaml-dev \
      zlib1g-dev && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

USER ubuntu

ENV PATH=/home/ubuntu/.rbenv/bin:/home/ubuntu/.rbenv/shims:${PATH}
RUN mkdir -p /home/ubuntu/.rbenv && \
    curl -fsSL https://github.com/rbenv/rbenv/archive/refs/tags/v1.3.2.tar.gz | \
      tar -xz --strip-components=1 -C /home/ubuntu/.rbenv && \
    mkdir -p /home/ubuntu/.rbenv/plugins/ruby-build && \
    curl -fsSL https://github.com/rbenv/ruby-build/archive/refs/tags/v20251203.tar.gz | \
      tar -xz --strip-components=1 -C /home/ubuntu/.rbenv/plugins/ruby-build && \
    rbenv install 2.7.8 && \
    /home/ubuntu/.rbenv/versions/2.7.8/bin/gem install \
      ceedling -v 0.31.0 && \
    rbenv install 3.4.7 && \
    /home/ubuntu/.rbenv/versions/3.4.7/bin/gem install \
      ceedling -v 1.0.1

USER root

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      gdb \
      git \
      npm \
      neovim \
      ssh && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /home/ubuntu

CMD ["/bin/bash"]
