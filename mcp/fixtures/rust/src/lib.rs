pub mod dhcp;

pub struct Lease {
    pub addr: u32,
    pub ttl: u32,
}

pub trait Renew {
    fn renew(&mut self, ttl: u32);
}

impl Renew for Lease {
    fn renew(&mut self, ttl: u32) {
        self.ttl = ttl;
    }
}

impl Lease {
    pub fn new(addr: u32) -> Lease {
        Lease { addr, ttl: 0 }
    }

    pub fn expired(&self) -> bool {
        self.ttl == 0
    }
}
